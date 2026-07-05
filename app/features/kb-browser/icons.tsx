/**
 * Local SVGs from kb-browser.jsx (verbatim paths) — NOT part of the shared
 * Icon set. FolderIco is exported for org-settings row buttons.
 */

export function FolderIco({ open }: { open?: boolean }) {
  return (
    <svg
      className="ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? (
        <path d="M3.5 8V6.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2V10M3.5 8h16.2l-1.6 9a2 2 0 0 1-2 1.6H6.6a2 2 0 0 1-2-1.6z" />
      ) : (
        <path d="M3.5 7a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      )}
    </svg>
  );
}

export function UploadIco() {
  return (
    <svg
      className="ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V5M7.5 9L12 4.5 16.5 9M5 19.5h14" />
    </svg>
  );
}

export function FolderUpIco() {
  return (
    <svg
      className="ico"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 7a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <path d="M12 16v-5.5M9.5 12.5L12 10l2.5 2.5" />
    </svg>
  );
}
