import * as vscode from 'vscode';
import * as lc from 'vscode-languageclient';
import * as ra from './lsp_ext';
import * as tasks from './tasks';

import { Ctx } from './ctx';
import { makeDebugConfig } from './debug';
import { Config } from './config';

const quickPickButtons = [{ iconPath: new vscode.ThemeIcon("save"), tooltip: "Save as a launch.json configurtation." }];

export async function selectRunnable(ctx: Ctx, prevRunnable?: RunnableQuickPick, debuggeeOnly = false, showButtons: boolean = true): Promise<RunnableQuickPick | undefined> {
    const editor = ctx.activeRustEditor;
    const client = ctx.client;
    if (!editor || !client) return;

    const textDocument: lc.TextDocumentIdentifier = {
        uri: editor.document.uri.toString(),
    };

    const runnables = await client.sendRequest(ra.runnables, {
        textDocument,
        position: client.code2ProtocolConverter.asPosition(
            editor.selection.active,
        ),
    });
    const items: RunnableQuickPick[] = [];
    if (prevRunnable) {
        items.push(prevRunnable);
    }
    for (const r of runnables) {
        if (
            prevRunnable &&
            JSON.stringify(prevRunnable.runnable) === JSON.stringify(r)
        ) {
            continue;
        }

        if (debuggeeOnly && (r.label.startsWith('doctest') || r.label.startsWith('cargo'))) {
            continue;
        }
        items.push(new RunnableQuickPick(r));
    }

    if (items.length === 0) {
        // it is the debug case, run always has at least 'cargo check ...'
        // see crates\rust-analyzer\src\main_loop\handlers.rs, handle_runnables
        vscode.window.showErrorMessage("There's no debug target!");
        return;
    }

    return await new Promise((resolve) => {
        const disposables: vscode.Disposable[] = [];
        const close = (result?: RunnableQuickPick) => {
            resolve(result);
            disposables.forEach(d => d.dispose());
        };

        const quickPick = vscode.window.createQuickPick<RunnableQuickPick>();
        quickPick.items = items;
        quickPick.title = "Select Runnable";
        if (showButtons) {
            quickPick.buttons = quickPickButtons;
        }
        disposables.push(
            quickPick.onDidHide(() => close()),
            quickPick.onDidAccept(() => close(quickPick.selectedItems[0])),
            quickPick.onDidTriggerButton((_button) => {
                (async () => await makeDebugConfig(ctx, quickPick.activeItems[0].runnable))();
                close();
            }),
            quickPick.onDidChangeActive((active) => {
                if (showButtons && active.length > 0) {
                    if (active[0].label.startsWith('cargo')) {
                        // save button makes no sense for `cargo test` or `cargo check`
                        quickPick.buttons = [];
                    } else if (quickPick.buttons.length === 0) {
                        quickPick.buttons = quickPickButtons;
                    }
                }
            }),
            quickPick
        );
        quickPick.show();
    });
}

export class RunnableQuickPick implements vscode.QuickPickItem {
    public label: string;
    public description?: string | undefined;
    public detail?: string | undefined;
    public picked?: boolean | undefined;

    constructor(public runnable: ra.Runnable) {
        this.label = runnable.label;
    }
}

export async function createTask(runnable: ra.Runnable, config: Config): Promise<vscode.Task> {
    if (runnable.kind !== "cargo") {
        // rust-analyzer supports only one kind, "cargo"
        // do not use tasks.TASK_TYPE here, these are completely different meanings.

        throw `Unexpected runnable kind: ${runnable.kind}`;
    }

    const args = [...runnable.args.cargoArgs]; // should be a copy!
    if (runnable.args.executableArgs.length > 0) {
        args.push('--', ...runnable.args.executableArgs);
    }
    const definition: tasks.CargoTaskDefinition = {
        type: tasks.TASK_TYPE,
        command: args[0], // run, test, etc...
        args: args.slice(1),
        cwd: runnable.args.workspaceRoot,
        env: Object.assign({}, process.env as { [key: string]: string }, { "RUST_BACKTRACE": "short" }),
    };

    const target = vscode.workspace.workspaceFolders![0]; // safe, see main activate()
    const cargoTask = await tasks.buildCargoTask(target, definition, runnable.label, args, config.cargoRunner, true);
    cargoTask.presentationOptions.clear = true;

    return cargoTask;
}
