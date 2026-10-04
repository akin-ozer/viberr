import { mergeNotifPrefs } from "~/features/profile/notification-prefs";
import type { ProfileData } from "~/features/profile/profile-page";

/** A maintainer's profile with neither GitHub nor an agent account connected:
 *  the Profile page's fixture, shared by the page's tests and the route's. */
export const PROFILE_DATA: ProfileData = {
  user: {
    id: "u_arda",
    name: "Arda Kaya",
    title: "Senior engineer",
    email: "arda@viberr.dev",
    idp: "local",
    createdAt: "2026-02-18T09:00:00.000Z",
    avatarTone: "",
    hasPassword: true,
    githubConnected: false,
    githubHandle: null,
  },
  memberships: [{ slug: "viberr-core", name: "Viberr Core", role: "maintainer" }],
  accessRole: "maintainer",
  githubConfigured: true,
  // Ruling 127: the viewer's own agent accounts, neither connected.
  backends: [
    {
      backend: "claude",
      health: {
        backend: "claude",
        userId: "u_arda",
        available: false,
        kind: null,
        method: null,
        verification: "none",
        secretSuffix: null,
        verifiedAt: null,
        connectedAt: null,
        detail:
          "Claude isn't connected. Connect it on your Profile → Agent accounts.",
        accountId: null,
        accountName: null,
      },
      login: null,
      methods: { signIn: ["claudeai", "console"], paste: ["api_key"] },
      accounts: [],
      limits: { maxAccounts: 10, maxLabelLength: 60 },
      lastRefusal: null,
      usage: null,
    },
    {
      backend: "codex",
      health: {
        backend: "codex",
        userId: "u_arda",
        available: false,
        kind: null,
        method: null,
        verification: "none",
        secretSuffix: null,
        verifiedAt: null,
        connectedAt: null,
        detail:
          "Codex isn't connected. Connect it on your Profile → Agent accounts.",
        accountId: null,
        accountName: null,
      },
      login: null,
      methods: { signIn: ["device"], paste: ["api_key", "access_token"] },
      accounts: [],
      limits: { maxAccounts: 10, maxLabelLength: 60 },
      lastRefusal: null,
      usage: null,
    },
  ],
  prefs: { notifs: mergeNotifPrefs(null), tlDefault: "all" },
};
