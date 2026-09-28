/**
 * The files a multipart form carries under `field`, as the upload writers take
 * them: a name and the bytes. A picker left empty posts one empty entry, which
 * is not a file. One reader for every form that takes files: the New task
 * dialog's (ruling 533), a task comment's and a controller message's (ruling
 * 573).
 */
export async function formFiles(
  formData: FormData,
  field = "files",
): Promise<{ name: string; data: Uint8Array }[]> {
  const files = formData.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
  return Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
}
