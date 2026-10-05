/**
 * Ruling 127: the sentence a person with no Claude connected reads from the
 * controller. The server answers it in the transcript and, U35-4 (pass 35),
 * from the HTTP send door itself, as a 409 before any thread is created; both
 * composers show it as the note beside the box (`NotConnectedNote`), so the
 * door says no where the disabled composer already did. One string in a
 * client-safe leaf (ruling 657), because a client module cannot import it from
 * the server.
 */
export const CONTROLLER_NOT_CONNECTED_NOTE =
  "The controller runs on your own Claude account, and Claude isn't connected for you yet. " +
  "Connect it on your Profile → Agent accounts, then send your message again.";
