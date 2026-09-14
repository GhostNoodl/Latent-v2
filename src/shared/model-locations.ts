import type { ModelKind } from './types';
export interface ModelLocationBinding {
  modelId: string;
  kind: ModelKind;
  relativePath: string;
  sha256: string;
  /** Reserved previous paths, including the original legacy model-ID path. */
  aliases: string[];
  createdAt: string;
  updatedAt: string;
}
export interface ModelFolder { kind: ModelKind; relativePath: string; }
export interface ExternalModelRoot {
  id: string;
  kind: ModelKind;
  label: string;
  /** An explicitly chosen read-only directory, shown for user review. */
  path: string;
  active: boolean;
  modelCount: number;
  error?: string;
}
/** Main-owned launch configuration; never accept these paths from renderer IPC. */
export interface BackendModelRoot { id: string; kind: ModelKind; path: string; }
export interface ExternalModelFile {
  id: string; rootId: string; kind: ModelKind; filename: string;
  sha256: string; bytes: number; status: 'ready' | 'missing';
  header?: Record<string, string>;
}
export interface ModelLocationsSnapshot {
  schemaVersion: 1;
  folders: ModelFolder[];
  bindings: ModelLocationBinding[];
  recoveryRequired: boolean;
  changeBlockedReason?: string;
  error?: string;
  externalRoots?: ExternalModelRoot[];
}
export interface CreateModelFolderRequest { kind: ModelKind; parent: string; name: string; }
export interface MoveModelRequest { modelId: string; destinationFolder: string; expectedSha256: string; }
export interface ModelLocationsActions {
  createFolder(request: CreateModelFolderRequest): Promise<ModelLocationsSnapshot>;
  moveModel(request: MoveModelRequest): Promise<ModelLocationsSnapshot>;
  recover(): Promise<ModelLocationsSnapshot>;
  /** Only kind crosses IPC. Main asks the user to choose a directory. */
  chooseExternalRoot?(kind: ModelKind): Promise<ModelLocationsSnapshot | null>;
  unregisterExternalRoot?(rootId: string): Promise<ModelLocationsSnapshot>;
}
/** Main-owned lookup only; these are not renderer IPC methods. */
export interface ModelLocationLookup {
  scanBindings(): readonly ModelLocationBinding[];
  assertDestinationAvailable(kind: ModelKind, relativePath: string): void | Promise<void>;
  scanExternalModels?(): Promise<ExternalModelFile[]>;
  verifyExternalModels?(modelIds: readonly string[]): Promise<void>;
}
