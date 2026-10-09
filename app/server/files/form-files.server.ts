/**
 * The files a multipart form carries under `files`, as the upload writers take
 * them: a name and the bytes. A picker left empty posts one empty entry, which
 * is not a file. One reader for every form that takes files: the New task
 * dialog's (ruling 76), a task comment's and a controller message's (ruling
 * 258).
 */
export async function formFiles(formData: FormData): Promise<{ name: string; data: Uint8Array }[]> {
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  return Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
}
