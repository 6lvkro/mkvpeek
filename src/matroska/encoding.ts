export interface ContentEncoding {
  scope: number;
}

/** The ContentEncodingScope bit that covers the frames. */
export const FRAMES_SCOPE = 1;

export function codecPrivateOf(
  stated: Uint8Array | null,
  encodings: readonly ContentEncoding[] | null,
): Uint8Array | null {
  if (encodings === null || encodings.some(reachesPastKnownScopes)) return null;
  const covered = encodings.some((encoding) => (encoding.scope & CODEC_PRIVATE_SCOPE) !== 0);
  return covered ? null : stated;
}

/** The ContentEncodingScope bit that covers CodecPrivate. */
const CODEC_PRIVATE_SCOPE = 2;

const KNOWN_SCOPES = FRAMES_SCOPE | CODEC_PRIVATE_SCOPE;

const reachesPastKnownScopes = ({ scope }: ContentEncoding): boolean =>
  (scope & ~KNOWN_SCOPES) !== 0;
