/**
 * Minimal type definitions for the VS Code built-in git extension API (vscode.git).
 * Only the members required by this extension are declared here.
 * The full API is defined in the git extension's own git.d.ts.
 */

import type { Event, Uri } from "vscode";

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
}

export interface GitRepository {
  readonly rootUri: Uri;
  /** Fires before a commit is created. Async handlers are awaited before the commit proceeds. */
  readonly onWillCommit?: Event<void>;
}
