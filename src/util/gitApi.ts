/**
 * Minimal type definitions for the VS Code built-in git extension API (vscode.git).
 * Only the members required by this extension are declared here.
 * The full public API is defined in the git extension's own git.d.ts
 * (extensions/git/src/api/git.d.ts in the VS Code repository).
 */

import type { Command, Disposable, Event, Uri } from "vscode";

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: Event<GitRepository>;
  readonly onDidCloseRepository: Event<GitRepository>;
  /** Registers a provider that supplies commands shown after a commit completes. */
  registerPostCommitCommandsProvider(provider: PostCommitCommandsProvider): Disposable;
}

export interface GitRepository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  /** Fires after a commit is created. */
  readonly onDidCommit: Event<void>;
}

export interface RepositoryState {
  /** Files currently in the staging area (index). */
  readonly indexChanges: RepositoryChange[];
  readonly onDidChange: Event<void>;
}

/** Represents a file change in the repository. */
export interface RepositoryChange {
  readonly uri: Uri;
}

/**
 * Provides commands that are offered to the user after a commit completes.
 * Returning a non-empty array causes VS Code to show those commands in the
 * Source Control post-commit action area.
 */
export interface PostCommitCommandsProvider {
  getCommands(repository: GitRepository): Command[];
}
