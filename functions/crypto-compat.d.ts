// TypeScript 5.9 models Uint8Array as potentially backed by ArrayBufferLike,
// while the Cloudflare Web Crypto runtime accepts Uint8Array as BufferSource.
// This overload keeps the worker typecheck aligned with the runtime API for PBKDF2.
interface SubtleCrypto {
  deriveBits(
    algorithm: {
      name: 'PBKDF2';
      hash: string;
      salt: Uint8Array;
      iterations: number;
    },
    baseKey: CryptoKey,
    length: number,
  ): Promise<ArrayBuffer>;
}
