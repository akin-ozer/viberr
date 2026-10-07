// Lives apart from user-menu.tsx, the trigger pages render, so that file
// exports only components (Fast Refresh boundary, as app/ui/initials.ts is for
// avatar.tsx). The menu is user-menu-panel.tsx.

/** The trigger's classes, shared by this trigger and the menu's. */
export function accountTriggerClass(open: boolean): string {
  return "home-user" + (open ? " open" : "");
}
