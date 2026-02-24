import * as vscode from "vscode";
import { CreateUserProfileCommand } from "./commands/CreateUserProfileCommand";
import { DeleteUserProfileCommand } from "./commands/DeleteUserProfileCommand";
import { EditUserProfileCommand } from "./commands/EditUserProfileCommand";
import { GetUserProfileCommand } from "./commands/GetUserProfileCommand";
import { PickUserProfileCommand } from "./commands/PickUserProfileCommand";
import { ShowStatusCommand } from "./commands/ShowStatusCommand";
import { StatusBarClickCommand } from "./commands/StatusBarClickCommand";
import { SyncVscProfilesWithGitConfig } from "./commands/SyncVscProfilesWithGitConfig";
import { ValidateProfileCommand } from "./commands/ValidateProfileCommand";
import * as constants from "./constants";
import { LogCategory } from "./constants";
import { ProfileStatusBar as statusBar } from "./controls";
import { debounce } from "./util/debounce";
import type { GitAPI, GitExtension, GitRepository } from "./util/gitApi";
import { invalidateWorkspaceStatusCache } from "./util/gitManager";
import { Logger } from "./util/logger";

const _fileWatchersBySrc = new Map</* src: */ string, vscode.FileSystemWatcher>();

export async function activate(context: vscode.ExtensionContext) {
  try {
    Logger.instance.logInfo("Activating extension");

    registerCommands(context);

    createGitConfigFileWatcher();

    Logger.instance.logInfo("Initializing commands complete.");

    // Now register event listeners before initial load
    registerForVSCodeEditorEvents(context);

    // Register pre-commit profile watcher (responds dynamically to setting changes)
    registerCommitProfileWatcher(context);

    // Get the initial user profile after everything is set up
    // Call immediately to ensure status bar appears on activation
    try {
      await vscode.commands.executeCommand(constants.CommandIds.GET_USER_PROFILE, "extension activated");
    } catch (error) {
      Logger.instance.logError("Error occurred during initial profile load", error as Error);
    }
  } catch (error) {
    Logger.instance.logError("Error occurred during extension activation", error as Error);
  }
}

function registerCommands(context: vscode.ExtensionContext) {
  Logger.instance.logInfo("Initializing commands");
  context.subscriptions.push(vscode.commands.registerCommand(constants.CommandIds.STATUS_BAR_CLICK, new StatusBarClickCommand().execute));
  context.subscriptions.push(statusBar.instance.StatusBar);
  context.subscriptions.push(vscode.commands.registerCommand(constants.CommandIds.CREATE_USER_PROFILE, new CreateUserProfileCommand().execute));
  context.subscriptions.push(vscode.commands.registerCommand(constants.CommandIds.SYNC_VSC_PROFILES_WITH_GIT_CONFIG, new SyncVscProfilesWithGitConfig().execute));
  context.subscriptions.push(vscode.commands.registerCommand(constants.CommandIds.EDIT_USER_PROFILE, new EditUserProfileCommand().execute));
  context.subscriptions.push(vscode.commands.registerCommand(constants.CommandIds.GET_USER_PROFILE, new GetUserProfileCommand().execute));
  context.subscriptions.push(vscode.commands.registerCommand(constants.CommandIds.DELETE_USER_PROFILE, new DeleteUserProfileCommand().execute));
  context.subscriptions.push(vscode.commands.registerCommand(constants.CommandIds.VALIDATE_USER_PROFILE, new ValidateProfileCommand().execute));
  context.subscriptions.push(vscode.commands.registerCommand(constants.CommandIds.PICK_USER_PROFILE, new PickUserProfileCommand().execute));
  context.subscriptions.push(vscode.commands.registerCommand(constants.CommandIds.SHOW_STATUS, new ShowStatusCommand().execute));
  statusBar.instance.attachCommand(constants.CommandIds.STATUS_BAR_CLICK);
}

function registerForVSCodeEditorEvents(context: vscode.ExtensionContext) {
  Logger.instance.logInfo("Registering for vs settings change event");

  // Debounced handler for editor changes to prevent flickering
  const debouncedGetUserProfile = debounce(async (origin: string) => {
    await vscode.commands.executeCommand(constants.CommandIds.GET_USER_PROFILE, origin);
  }, 300);

  // Debounce configuration changes to prevent multiple rapid calls
  const debouncedConfigChange = debounce(async () => {
    invalidateWorkspaceStatusCache();
    await vscode.commands.executeCommand(constants.CommandIds.GET_USER_PROFILE, "changed settings");
  }, 300);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      // Only react to changes in our extension's configuration
      if (e.affectsConfiguration("gitConfigUser")) {
        Logger.instance.logDebug(LogCategory.SETTINGS_CHANGE, "Extension configuration changed", {
          affectsProfiles: e.affectsConfiguration("gitConfigUser.profiles"),
          affectsAutoSelect: e.affectsConfiguration("gitConfigUser.selectMatchedProfileAutomatically"),
          affectsStatusBarAlignment: e.affectsConfiguration("gitConfigUser.statusBarAlignment"),
        });

        // Handle status bar alignment changes immediately (no debounce needed)
        if (e.affectsConfiguration("gitConfigUser.statusBarAlignment")) {
          Logger.instance.logInfo("Status bar alignment configuration changed, recreating status bar");
          statusBar.instance.recreateStatusBarItem();
        }

        debouncedConfigChange();
      }
    })
  );

  // Debounce editor changes to prevent flickering when switching between multiple editors
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const editorInfo = editor
        ? {
            uri: editor.document.uri.toString(),
            scheme: editor.document.uri.scheme,
            fileName: editor.document.fileName,
            languageId: editor.document.languageId,
          }
        : { message: "No active editor" };

      Logger.instance.logTrace(LogCategory.WORKSPACE_STATUS, "Active text editor changed", editorInfo);
      debouncedGetUserProfile("changed active editor");
    })
  );

  // Keep workspace folder changes without debouncing as they're infrequent but important
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      const changeInfo = {
        added: event.added.map((f) => ({ name: f.name, uri: f.uri.toString() })),
        removed: event.removed.map((f) => ({ name: f.name, uri: f.uri.toString() })),
        totalFolders: vscode.workspace.workspaceFolders?.length || 0,
      };

      Logger.instance.logDebug(LogCategory.WORKSPACE_STATUS, "Workspace folders changed", changeInfo);

      // Invalidate cache when workspace folders change
      invalidateWorkspaceStatusCache();
      await vscode.commands.executeCommand(constants.CommandIds.GET_USER_PROFILE, "changed workspace folders");
    })
  );

  // Removed onDidOpenTextDocument and onDidCloseTextDocument as they are redundant
  // These events are already covered by onDidChangeActiveTextEditor
}

function registerCommitProfileWatcher(context: vscode.ExtensionContext) {
  const isEnabled = () => vscode.workspace.getConfiguration("gitConfigUser").get<boolean>("promptForProfileOnCommit") === true;

  // Always register the watcher unconditionally so that toggling the setting on
  // takes effect immediately without requiring a VS Code restart.
  // The isEnabled() guard inside each handler ensures no-op behaviour when disabled.

  const gitExtension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!gitExtension) {
    Logger.instance.logDebug(LogCategory.COMMIT_PROFILE_PROMPT, "vscode.git extension not found; skipping commit profile watcher", {});
    return;
  }

  const gitAPI: GitAPI = gitExtension.exports.getAPI(1);

  const subscribeToRepository = (repo: GitRepository) => {
    if (!repo.onWillCommit) {
      Logger.instance.logDebug(LogCategory.COMMIT_PROFILE_PROMPT, "Repository does not expose onWillCommit; skipping", {
        rootUri: repo.rootUri.fsPath,
      });
      return;
    }

    Logger.instance.logDebug(LogCategory.COMMIT_PROFILE_PROMPT, "Subscribing to onWillCommit for repository", {
      rootUri: repo.rootUri.fsPath,
    });

    context.subscriptions.push(
      repo.onWillCommit(async () => {
        if (!isEnabled()) {
          return;
        }

        try {
          const { getSelectedProfileId, getProfilesInSettings } = await import("./config");
          const profiles = getProfilesInSettings();

          if (profiles.length === 0) {
            Logger.instance.logDebug(LogCategory.COMMIT_PROFILE_PROMPT, "No profiles defined; skipping commit profile prompt", {});
            return;
          }

          const selectedId = getSelectedProfileId(repo.rootUri);
          const selectedProfile = selectedId ? profiles.find((p) => p.id === selectedId) : undefined;

          if (selectedProfile) {
            Logger.instance.logDebug(LogCategory.COMMIT_PROFILE_PROMPT, "Profile already selected for this repository; skipping prompt", {
              profile: selectedProfile.label,
            });
            return;
          }

          Logger.instance.logInfo("No profile selected for repository; prompting user before commit");

          const profilePickResult = await vscode.commands.executeCommand<{ result?: unknown }>(constants.CommandIds.PICK_USER_PROFILE);

          // If the user cancelled (no profile in result), block the commit
          if (!profilePickResult?.result) {
            throw new Error("Commit cancelled: no git user profile selected. Pick a profile and try again.");
          }
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Commit cancelled:")) {
            throw error;
          }
          Logger.instance.logError("Error in commit profile prompt handler", error as Error);
        }
      })
    );
  };

  // Subscribe to all existing repositories
  for (const repo of gitAPI.repositories) {
    subscribeToRepository(repo);
  }

  // Subscribe to future repositories
  context.subscriptions.push(gitAPI.onDidOpenRepository(subscribeToRepository));

  Logger.instance.logInfo("Commit profile watcher registered");
}

function createGitConfigFileWatcher() {
  // Delete stale file watchers.
  _fileWatchersBySrc.clear();

  const fsWatcher = vscode.workspace.createFileSystemWatcher("**/.git/config");
  fsWatcher.onDidChange(async (uri) => {
    Logger.instance.logDebug(LogCategory.GIT_CONFIG_FILE, "Git config file changed", { uri: uri.toString() });
    // Invalidate cache when git config file changes
    invalidateWorkspaceStatusCache();
    await vscode.commands.executeCommand(constants.CommandIds.GET_USER_PROFILE, "changed git config");
  });
  fsWatcher.onDidCreate(async (uri) => {
    Logger.instance.logDebug(LogCategory.GIT_CONFIG_FILE, "Git config file created", { uri: uri.toString() });
    // Invalidate cache when git config file is created
    invalidateWorkspaceStatusCache();
    await vscode.commands.executeCommand(constants.CommandIds.GET_USER_PROFILE, "created git config");
  });
  fsWatcher.onDidDelete(async (uri) => {
    Logger.instance.logDebug(LogCategory.GIT_CONFIG_FILE, "Git config file deleted", { uri: uri.toString() });
    // Invalidate cache when git config file is deleted
    invalidateWorkspaceStatusCache();
    await vscode.commands.executeCommand(constants.CommandIds.GET_USER_PROFILE, "deleted git config");
  });
  _fileWatchersBySrc.set("**/.git/config", fsWatcher);
  Logger.instance.logInfo("File watcher created for git config");
}

export function deactivate() {
  for (const entry of _fileWatchersBySrc.values()) {
    entry.dispose();
  }
  _fileWatchersBySrc.clear();
}
