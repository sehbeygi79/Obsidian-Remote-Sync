# Remote Sync

Remote Sync is an Obsidian plugin for reviewing and synchronizing files between a vault folder and Google Drive. You choose what to apply; changes are not synchronized automatically.

## Install

Remote Sync requires Obsidian 1.8.7 or later. Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/obsidian-remote-sync/`, then enable Remote Sync under **Settings → Community plugins**.

To build from source, use Node.js 22.12 or later and npm:

```sh
npm install
npm run build
```

The installable files are placed in `obsidian-remote-sync/`. Reload the plugin after updating them.

## Connect Google Drive

1. Create a Google Cloud project and enable the Google Drive API.
2. Configure the OAuth consent screen, add your Google account as a test user if applicable, and add the `https://www.googleapis.com/auth/drive` scope.
3. Create a **Desktop app** OAuth client. In Remote Sync settings, connect your Google account with its client ID and secret, and follow the consent prompts. Choose a passphrase to encrypt the credentials on your device.
4. Add a remote and select a Drive folder. You can save multiple accounts and remotes, and select one for each sync.

The plugin requests full Drive access to discover existing files, even though sync actions target the selected folder. Shared drives are not supported. Start with a disposable vault and folder while you learn the workflow.

On Android, use the encrypted credential export from a connected desktop installation and import it in the plugin settings. Transfer the export securely and communicate its passphrase separately. Keep private plugin data out of other sync services and backups accessible to others.

## Sync files

1. In settings, add or select a local vault folder. Enter `./` to select the whole vault. The default is `materials/`.
2. Select a remote, then open **Remote Sync: Review Status** from the command palette or the ribbon.
3. Scan, review the listed differences, and select the actions you want. Conflicts and deletions require an explicit choice.
4. Apply the selected actions and review the confirmation. Use **History** to inspect results and scan again for remaining changes.

Each local-folder and remote combination has its own sync baseline. Changes in one pairing may appear in another pairing that uses the same local folder. Switching folders or remotes requires a fresh review.

In settings, **Ignored files and folders** accepts one vault-relative rule per line. Folder rules include descendants; `*` matches names and `**` matches nested paths. Ignored items are omitted from review, without deleting the files or their existing history.

## Things to know

- Trash actions use recoverable local or Google Drive trash; review deletion choices carefully.
- Transfers can run concurrently. Lower the simultaneous-transfer setting for large files or memory-constrained devices: files are buffered in memory.
- The plugin stores encrypted credentials and device-specific sync state locally. Use its export/import workflow to move credentials between devices; do not copy private state between installations.
- External edits or interruptions can occur during a sync. Review any reported failure or unresolved operation and scan again before retrying.
