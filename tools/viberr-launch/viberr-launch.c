/*
 * viberr-launch — run an agent process as its person's own OS user (ruling 139).
 *
 * The server runs as `node`. Before ruling 139 every agent CLI it spawned ran
 * as `node` too, so a run's shell could read the server's /proc/<pid>/environ
 * (the secret-encryption key, the session secret), the projection database and
 * every other person's sign-in. This binary is the one privileged step that
 * separates them: installed root:node mode 4750, only root and the server's
 * group can execute it, and it runs a command as a per-person agent uid
 * (AGENT_UID_FLOOR and up) in the shared primary group AGENT_GID.
 *
 * Verbs:
 *   exec (VIBERR_LAUNCH_EXEC set)     fork; the child drops to VIBERR_LAUNCH_UID and
 *                                     execs VIBERR_LAUNCH_EXEC with argv[1..]; the
 *                                     parent relays signals to the child's group
 *   --prepare-home <uid> <path>       create/own a path under the runtime homes
 *   --reap <0|TERM|KILL> <marker>...  signal agent processes by run marker
 *   --probe <path>                    can an unprivileged uid read <path>?
 *
 * The uid range, the agent gid, the server's ids and the data root are compiled
 * in (Dockerfile ARGs), never read from the environment: this binary is
 * setuid root, and nothing a caller controls may widen what it does.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/fsuid.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if !defined(AGENT_UID_FLOOR) || !defined(AGENT_UID_MAX) || !defined(AGENT_GID) || \
    !defined(SERVER_UID) || !defined(SERVER_GID) || !defined(DATA_ROOT)
#error "build with -DAGENT_UID_FLOOR -DAGENT_UID_MAX -DAGENT_GID -DSERVER_UID -DSERVER_GID -DDATA_ROOT"
#endif

/* The one uid below the range: the boot probe reads the store as it. */
#define PROBE_UID (AGENT_UID_FLOOR - 1)
#define USERS_ROOT DATA_ROOT "/runtimes/users"
#define LAUNCH_PREFIX "VIBERR_LAUNCH_"
#define MARKER_PREFIX "VIBERR_RUN_ID="
/* Between a relayed SIGTERM and the SIGKILL that follows it. */
#define GRACE_SECONDS 5
/* How deep a home walk descends; a deeper tree is left as it is. */
#define MAX_DEPTH 64
#define MAX_MARKERS 64
#define MAX_MARKER_LEN 128

extern char **environ;

static char exec_path[PATH_MAX];
static char home_path[PATH_MAX];
/* One process's environment at a time, for --reap. */
static char environ_buf[1 << 20];

static void refuse(const char *message) {
  fprintf(stderr, "viberr-launch: %s\n", message);
  exit(126);
}

static void fail(const char *what) {
  fprintf(stderr, "viberr-launch: %s: %s\n", what, strerror(errno));
  exit(126);
}

/* Digits only, no sign, no overflow, inside [lo, hi]. */
static int parse_id(const char *text, unsigned long lo, unsigned long hi, unsigned long *out) {
  if (!text || !*text || strlen(text) > 10) return -1;
  unsigned long value = 0;
  for (const char *c = text; *c; c++) {
    if (*c < '0' || *c > '9') return -1;
    value = value * 10 + (unsigned long)(*c - '0');
  }
  if (value < lo || value > hi) return -1;
  *out = value;
  return 0;
}

/* Become `uid` in the agent group for good. setgroups first (it needs root),
 * then the gid, then the uid, and every id is read back: a partial drop must
 * never exec anything. */
static void drop_to(uid_t uid) {
  if (setgroups(0, NULL) != 0) fail("setgroups");
  if (setgid(AGENT_GID) != 0) fail("setgid");
  if (setuid(uid) != 0) fail("setuid");
  uid_t ruid, euid, suid;
  gid_t rgid, egid, sgid;
  if (getresuid(&ruid, &euid, &suid) != 0 || ruid != uid || euid != uid || suid != uid)
    refuse("the uid did not change");
  if (getresgid(&rgid, &egid, &sgid) != 0 || rgid != AGENT_GID || egid != AGENT_GID ||
      sgid != AGENT_GID)
    refuse("the gid did not change");
  if (getgroups(0, NULL) != 0) refuse("supplementary groups survived the drop");
  /* The saved uid is gone too, so root cannot come back. */
  if (setuid(0) == 0) refuse("root could be regained after the drop");
}

/* Remove every VIBERR_LAUNCH_* variable, so the agent never sees them. */
static void scrub_launch_env(void) {
  for (;;) {
    char **entry = environ;
    while (entry && *entry && strncmp(*entry, LAUNCH_PREFIX, strlen(LAUNCH_PREFIX)) != 0) entry++;
    if (!entry || !*entry) return;
    char name[256];
    const char *eq = strchr(*entry, '=');
    size_t len = eq ? (size_t)(eq - *entry) : strlen(*entry);
    if (len >= sizeof name) refuse("an oversized VIBERR_LAUNCH_ variable");
    memcpy(name, *entry, len);
    name[len] = '\0';
    if (unsetenv(name) != 0) fail("unsetenv");
  }
}

/* ------------------------------------------------------------ home ownership */

/* Every step of a home walk is best effort: a failure leaves that entry as it
 * was, and the walk goes on. This consumes a result the compiler insists on. */
static void attempt(int result) { (void)result; }

/* Give one open entry to `uid`:SERVER_GID. A directory becomes 2770 (setgid,
 * so what the agent creates inside stays in the server's group); a file keeps
 * its permission bits, gains group read and write (the server reads a sign-in
 * a vendor wrote 0600, and updates the Codex state database), and loses
 * setuid/setgid. `seen` is what fstatat saw before the open: the fd must still
 * be that entry, so a swap in between changes nothing. */
static void own_fd(int fd, const struct stat *seen, uid_t uid, int is_dir) {
  struct stat st;
  if (fstat(fd, &st) != 0) return;
  if (st.st_ino != seen->st_ino || st.st_dev != seen->st_dev) return;
  if (is_dir != (S_ISDIR(st.st_mode) ? 1 : 0)) return;
  if (st.st_uid != uid && st.st_uid != SERVER_UID) return;
  if (!is_dir && st.st_uid == SERVER_UID && st.st_nlink > 1) return;
  if ((st.st_uid != uid || st.st_gid != SERVER_GID) && fchown(fd, uid, SERVER_GID) != 0) return;
  mode_t want = is_dir ? 02770 : ((st.st_mode & 0777) | S_IRGRP | S_IWGRP);
  /* fchown by root clears setuid bits itself; the comparison is on what is left. */
  if ((st.st_mode & 07777) != want) attempt(fchmod(fd, want));
}

static void own_entry(int parent, const char *name, uid_t uid, int depth);

/* Create a directory AS THE SERVER (its filesystem ids, for this one call): a
 * directory root created would belong to root, which the walk never touches,
 * and the server could have created it itself. The walk then hands it over. */
static int mkdir_as_server(int parent, const char *name) {
  setfsgid(SERVER_GID);
  setfsuid(SERVER_UID);
  int result = mkdirat(parent, name, 0700);
  int saved = errno;
  setfsuid(0);
  setfsgid(0);
  errno = saved;
  return result;
}

static void own_children(int dir, uid_t uid, int depth) {
  int copy = dup(dir);
  if (copy < 0) return;
  DIR *listing = fdopendir(copy);
  if (!listing) {
    close(copy);
    return;
  }
  struct dirent *child;
  while ((child = readdir(listing)) != NULL) {
    if (strcmp(child->d_name, ".") == 0 || strcmp(child->d_name, "..") == 0) continue;
    own_entry(dir, child->d_name, uid, depth);
  }
  closedir(listing);
}

/* Walk one entry without ever following a symlink: every step is an openat
 * with O_NOFOLLOW relative to a directory fd already checked. Entries owned by
 * root or by another agent are skipped, so a hard link planted in a home
 * cannot point this walk at a file its owner does not own. */
static void own_entry(int parent, const char *name, uid_t uid, int depth) {
  struct stat st;
  if (fstatat(parent, name, &st, AT_SYMLINK_NOFOLLOW) != 0) return;
  if (st.st_uid != uid && st.st_uid != SERVER_UID) return;
  if (S_ISLNK(st.st_mode)) {
    /* The link itself is owned; what it points at is never touched. */
    if (st.st_uid != uid || st.st_gid != SERVER_GID)
      attempt(fchownat(parent, name, uid, SERVER_GID, AT_SYMLINK_NOFOLLOW));
    return;
  }
  if (S_ISDIR(st.st_mode)) {
    int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return;
    own_fd(fd, &st, uid, 1);
    if (depth < MAX_DEPTH) own_children(fd, uid, depth + 1);
    close(fd);
    return;
  }
  if (S_ISREG(st.st_mode)) {
    /* O_NONBLOCK and O_NOCTTY: opening must have no side effect. */
    int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
    if (fd < 0) return;
    own_fd(fd, &st, uid, 0);
    close(fd);
    return;
  }
  /* A FIFO or a socket: ownership only (no fd-based chmod exists for it). */
  attempt(fchownat(parent, name, uid, SERVER_GID, AT_SYMLINK_NOFOLLOW));
}

/* Resolve `path` (which must lie under USERS_ROOT) one component at a time
 * from a real USERS_ROOT, never following a symlink, creating a missing
 * directory when `create` is set. Every directory on the way must belong to
 * `uid` or to the server, so one agent's path cannot pass through another's
 * home. Returns the parent directory fd and leaves the last component in
 * `last`; -1 with `*why` set when the path does not resolve. Never exits: the
 * post-run pass must not replace the agent's exit status with its own. */
static int open_parent(const char *path, uid_t uid, int create, char *last, size_t last_cap,
                       const char **why) {
  size_t root_len = strlen(USERS_ROOT);
  char real[PATH_MAX];
  char rest[PATH_MAX];
  *why = "the path does not resolve";
  if (strncmp(path, USERS_ROOT "/", root_len + 1) != 0) {
    *why = "the path is not under " USERS_ROOT;
    return -1;
  }
  /* The root itself must be the real directory, with no symlink on its way. */
  if (!realpath(USERS_ROOT, real) || strcmp(real, USERS_ROOT) != 0) {
    *why = USERS_ROOT " is not a real directory";
    return -1;
  }
  if (strlen(path + root_len + 1) >= sizeof rest) {
    *why = "the path is too long";
    return -1;
  }
  strcpy(rest, path + root_len + 1);
  int dir = open(USERS_ROOT, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (dir < 0) return -1;
  char *cursor = rest;
  for (;;) {
    char *slash = strchr(cursor, '/');
    if (slash) *slash = '\0';
    if (*cursor == '\0' || strcmp(cursor, ".") == 0 || strcmp(cursor, "..") == 0 ||
        strlen(cursor) >= last_cap) {
      *why = "the path has an empty, ., .. or oversized component";
      close(dir);
      return -1;
    }
    if (!slash || slash[1] == '\0') {
      strcpy(last, cursor);
      struct stat st;
      if (create && fstatat(dir, cursor, &st, AT_SYMLINK_NOFOLLOW) != 0 &&
          (errno != ENOENT || (mkdir_as_server(dir, cursor) != 0 && errno != EEXIST))) {
        *why = "the directory could not be created";
        close(dir);
        return -1;
      }
      return dir;
    }
    int next = openat(dir, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0 && errno == ENOENT && create &&
        (mkdir_as_server(dir, cursor) == 0 || errno == EEXIST))
      next = openat(dir, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(dir);
    struct stat st;
    if (next < 0 || fstat(next, &st) != 0) {
      if (next >= 0) close(next);
      return -1;
    }
    if (st.st_uid != uid && st.st_uid != SERVER_UID) {
      *why = "a directory on the path belongs to someone else";
      close(next);
      return -1;
    }
    /* An intermediate directory is owned, not walked. */
    own_fd(next, &st, uid, 1);
    dir = next;
    cursor = slash + 1;
  }
}

static int prepare_home(int argc, char **argv) {
  unsigned long uid;
  if (argc != 4 || parse_id(argv[2], AGENT_UID_FLOOR, AGENT_UID_MAX, &uid) != 0)
    refuse("usage: --prepare-home <agent uid> <path under " USERS_ROOT ">");
  /* Exact modes: own_fd sets them explicitly, and mkdir must not add any. */
  umask(0077);
  char last[NAME_MAX + 1];
  const char *why;
  int parent = open_parent(argv[3], (uid_t)uid, 1, last, sizeof last, &why);
  if (parent < 0) refuse(why);
  own_entry(parent, last, (uid_t)uid, 0);
  close(parent);
  return 0;
}

/* After an agent exits: give it everything it left in its home (a vendor
 * writes its sign-in 0600) and let the server's group read it. */
static void own_home_after_run(uid_t uid) {
  char last[NAME_MAX + 1];
  const char *why;
  int parent = open_parent(home_path, uid, 0, last, sizeof last, &why);
  if (parent < 0) return;
  own_entry(parent, last, uid, 0);
  close(parent);
}

/* ----------------------------------------------------------------- reaping */

static ssize_t read_file(const char *path, char *buf, size_t cap) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t total = 0;
  while (total < cap - 1) {
    ssize_t n = read(fd, buf + total, cap - 1 - total);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) break;
    total += (size_t)n;
  }
  close(fd);
  buf[total] = '\0';
  return (ssize_t)total;
}

static int valid_marker(const char *marker) {
  size_t len = strlen(marker);
  if (len == 0 || len > MAX_MARKER_LEN) return 0;
  for (const char *c = marker; *c; c++) {
    if (!((*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') || (*c >= '0' && *c <= '9') ||
          *c == '_' || *c == '-' || *c == ':'))
      return 0;
  }
  return 1;
}

static int reap(int argc, char **argv) {
  int sig;
  if (argc < 4) refuse("usage: --reap <0|TERM|KILL> <run marker>...");
  if (strcmp(argv[2], "0") == 0) sig = 0;
  else if (strcmp(argv[2], "TERM") == 0) sig = SIGTERM;
  else if (strcmp(argv[2], "KILL") == 0) sig = SIGKILL;
  else refuse("the signal must be 0, TERM or KILL");
  if (argc - 3 > MAX_MARKERS) refuse("too many run markers");
  for (int i = 3; i < argc; i++)
    if (!valid_marker(argv[i])) refuse("a run marker has an unexpected character");

  DIR *proc = opendir("/proc");
  if (!proc) fail("open /proc");
  struct dirent *entry;
  while ((entry = readdir(proc)) != NULL) {
    unsigned long pid;
    if (parse_id(entry->d_name, 2, 4194304, &pid) != 0 || (pid_t)pid == getpid()) continue;
    /* A pidfd pins THIS process: if it exits and the pid is reused while its
     * files are read, the signal below goes nowhere instead of to a stranger. */
    int pidfd = (int)syscall(SYS_pidfd_open, (pid_t)pid, 0);
    if (pidfd < 0) continue;
    char file[64];
    char status[4096];
    snprintf(file, sizeof file, "/proc/%lu/status", pid);
    unsigned long ruid = 0, euid = 0;
    const char *line = read_file(file, status, sizeof status) > 0 ? strstr(status, "\nUid:") : NULL;
    if (!line || sscanf(line, "\nUid:%lu%lu", &ruid, &euid) != 2 || ruid < AGENT_UID_FLOOR ||
        ruid > AGENT_UID_MAX || euid < AGENT_UID_FLOOR || euid > AGENT_UID_MAX) {
      close(pidfd);
      continue;
    }
    /* Reading another uid's environ is a ptrace-read check, which this
     * container's root passes only as that uid (it holds no CAP_SYS_PTRACE):
     * borrow its filesystem ids for the one read, then take ours back. */
    setfsgid(AGENT_GID);
    setfsuid((uid_t)ruid);
    snprintf(file, sizeof file, "/proc/%lu/environ", pid);
    ssize_t len = read_file(file, environ_buf, sizeof environ_buf);
    setfsuid(0);
    setfsgid(0);
    int matched = 0;
    for (ssize_t at = 0; len > 0 && at < len && !matched; at += (ssize_t)strlen(environ_buf + at) + 1) {
      const char *var = environ_buf + at;
      if (strncmp(var, MARKER_PREFIX, strlen(MARKER_PREFIX)) != 0) continue;
      for (int i = 3; i < argc; i++)
        if (strcmp(var + strlen(MARKER_PREFIX), argv[i]) == 0) matched = 1;
    }
    if (matched && syscall(SYS_pidfd_send_signal, pidfd, sig, NULL, 0) == 0) printf("%lu\n", pid);
    close(pidfd);
  }
  closedir(proc);
  return 0;
}

/* ------------------------------------------------------------------ probe */

static int probe(int argc, char **argv) {
  if (argc != 3 || argv[2][0] != '/') refuse("usage: --probe <absolute path>");
  drop_to(PROBE_UID);
  int fd = open(argv[2], O_RDONLY | O_NOCTTY | O_NONBLOCK | O_CLOEXEC);
  if (fd >= 0) {
    close(fd);
    return 3; /* readable: this mount does not enforce file permissions */
  }
  if (errno == EACCES || errno == EPERM) return 0;
  fprintf(stderr, "viberr-launch: probe %s: %s\n", argv[2], strerror(errno));
  return 2;
}

/* ------------------------------------------------------------------- exec */

static int launch(char **argv) {
  unsigned long uid;
  if (parse_id(getenv("VIBERR_LAUNCH_UID"), AGENT_UID_FLOOR, AGENT_UID_MAX, &uid) != 0)
    refuse("VIBERR_LAUNCH_UID must be an agent uid in the compiled range");
  const char *exec = getenv("VIBERR_LAUNCH_EXEC");
  if (!exec || exec[0] != '/') refuse("VIBERR_LAUNCH_EXEC must be an absolute path");
  if (strlen(exec) >= sizeof exec_path) refuse("VIBERR_LAUNCH_EXEC is too long");
  strcpy(exec_path, exec);
  const char *home = getenv("VIBERR_LAUNCH_HOME");
  if (home) {
    if (strncmp(home, USERS_ROOT "/", strlen(USERS_ROOT) + 1) != 0 ||
        strlen(home) >= sizeof home_path)
      refuse("VIBERR_LAUNCH_HOME must be a home under " USERS_ROOT);
    strcpy(home_path, home);
  }
  scrub_launch_env();
  /* Waited for below: an inherited SIG_IGN would have the kernel reap it. */
  signal(SIGCHLD, SIG_DFL);

  pid_t launcher = getpid();
  pid_t server = getppid();
  /* A dying server takes its runs down: it SIGTERMs this process, which relays. */
  if (prctl(PR_SET_PDEATHSIG, SIGTERM) != 0) fail("prctl");
  if (getppid() != server) return 128 + SIGTERM;

  /* Blocked before the fork, so no signal can land between the fork and the
   * first wait; they are then taken synchronously, with their sender. */
  sigset_t relay, previous;
  sigemptyset(&relay);
  int relayed[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2, SIGCHLD};
  for (size_t i = 0; i < sizeof relayed / sizeof relayed[0]; i++) sigaddset(&relay, relayed[i]);
  if (sigprocmask(SIG_BLOCK, &relay, &previous) != 0) fail("sigprocmask");

  pid_t child = fork();
  if (child < 0) fail("fork");
  if (child == 0) {
    if (sigprocmask(SIG_SETMASK, &previous, NULL) != 0) _exit(126);
    /* The agent leads a group of its own, which this process is not in, so a
     * relay reaches every process the agent started and never the relayer. */
    if (setpgid(0, 0) != 0) _exit(126);
    drop_to((uid_t)uid);
    /* After the uid change, which would clear it: the agent dies with this
     * process even when this process is SIGKILLed. */
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) _exit(126);
    if (getppid() != launcher) _exit(126);
    /* What the agent creates is group-shared (the server is in the group),
     * never world-readable. */
    umask(0007);
    argv[0] = exec_path;
    execv(exec_path, argv);
    fprintf(stderr, "viberr-launch: cannot exec %s: %s\n", exec_path, strerror(errno));
    _exit(127);
  }
  /* Both sides set the group, so a relay can never race the child's own call. */
  (void)setpgid(child, child);

  int status = 0;
  int armed = 0;
  struct timespec deadline = {0, 0};
  for (;;) {
    siginfo_t info;
    int sig;
    if (armed) {
      struct timespec now, left;
      clock_gettime(CLOCK_MONOTONIC, &now);
      left.tv_sec = deadline.tv_sec - now.tv_sec;
      left.tv_nsec = deadline.tv_nsec - now.tv_nsec;
      if (left.tv_nsec < 0) {
        left.tv_sec -= 1;
        left.tv_nsec += 1000000000L;
      }
      if (left.tv_sec < 0) left.tv_sec = 0, left.tv_nsec = 0;
      sig = sigtimedwait(&relay, &info, &left);
      if (sig < 0 && errno == EAGAIN) {
        /* The grace after a relayed SIGTERM ran out. */
        (void)kill(-child, SIGKILL);
        armed = 0;
        continue;
      }
    } else {
      sig = sigwaitinfo(&relay, &info);
    }
    if (sig < 0) {
      if (errno == EINTR) continue;
      fail("sigwait");
    }
    if (sig == SIGCHLD) {
      if (waitpid(child, &status, WNOHANG) == child) break;
      continue;
    }
    if (sig == SIGUSR2) {
      /* The server's hard kill: it cannot signal the agent's uid itself. */
      (void)kill(-child, SIGKILL);
      continue;
    }
    (void)kill(-child, sig);
    if (sig == SIGTERM && !armed) {
      clock_gettime(CLOCK_MONOTONIC, &deadline);
      deadline.tv_sec += GRACE_SECONDS;
      armed = 1;
    }
  }
  /* What the agent left in its group (a stdio MCP server) gets the SIGTERM a
   * settled run's group always got; the settle sweep's --reap does the rest. */
  (void)kill(-child, SIGTERM);
  if (home_path[0]) own_home_after_run((uid_t)uid);
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}

int main(int argc, char **argv) {
  if (getenv("VIBERR_LAUNCH_EXEC")) return launch(argv);
  if (argc >= 2 && strcmp(argv[1], "--prepare-home") == 0) return prepare_home(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "--reap") == 0) return reap(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "--probe") == 0) return probe(argc, argv);
  refuse("usage: VIBERR_LAUNCH_UID=<uid> VIBERR_LAUNCH_EXEC=<path> viberr-launch [args...] | "
         "--prepare-home <uid> <path> | --reap <0|TERM|KILL> <marker>... | --probe <path>");
  return 126;
}
