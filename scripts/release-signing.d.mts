export function releaseSigningMessage(release: { name: string; bytes: number; sha256: string }): string;
export function signInstaller(installer: string, privateKeyPem: string): Promise<string>;
