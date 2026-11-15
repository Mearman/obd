import { canonicalJson, toBase64Url, type ShareCodec } from "../../src/core/index.js";

/** The `share=2.` fragment for any value as the envelope of a kind other than capture, packed as the encoder packs it but without its checks, so a test can hand the decoder a payload the encoder would refuse. */
export async function uncheckedFragment(
  kind: string,
  envelope: unknown,
  codec: ShareCodec,
): Promise<string> {
  const head = Uint8Array.from(canonicalJson([kind, envelope]), (character) =>
    character.charCodeAt(0),
  );
  const prefix: number[] = [];
  let rest = head.length;
  while (rest >= 0x80) {
    prefix.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  prefix.push(rest);
  const payload = new Uint8Array(prefix.length + head.length);
  payload.set(prefix, 0);
  payload.set(head, prefix.length);
  return `share=2.${toBase64Url(await codec.deflate(payload))}`;
}
