/**
 * Hands `content` to the browser as a file the user saves: a short-lived object URL clicked through a detached link, then revoked.
 *
 * @param filename The name the browser offers to save it as.
 * @param mediaType The file's media type.
 */
export function download(
  filename: string,
  mediaType: string,
  content: string | Uint8Array<ArrayBuffer>,
): void {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
