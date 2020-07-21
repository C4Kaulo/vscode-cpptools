/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All Rights Reserved.
 * See 'LICENSE' in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as DebuggerExtension from './Debugger/extension';
import * as fs from 'fs';
import * as LanguageServer from './LanguageServer/extension';
import * as os from 'os';
import * as path from 'path';
import * as Telemetry from './telemetry';
import * as util from './common';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { PersistentState } from './LanguageServer/persistentState';

import { CppToolsApi, CppToolsExtension } from 'vscode-cpptools';
import { getTemporaryCommandRegistrarInstance, initializeTemporaryCommandRegistrar } from './commands';
import { PlatformInformation, GetOSName } from './platform';
import { PackageManager, PackageManagerError, IPackage, VersionsMatch, ArchitecturesMatch, PlatformsMatch } from './packageManager';
import { getInstallationInformation, InstallationInformation, setInstallationStage, setInstallationType, InstallationType } from './installationInformation';
import { Logger, getOutputChannelLogger, showOutputChannel } from './logger';
import { CppTools1, NullCppTools } from './cppTools1';
import { CppSettings } from './LanguageServer/settings';
import { vsixNameForPlatform, releaseDownloadUrl } from './githubAPI';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const cppTools: CppTools1 = new CppTools1();
let languageServiceDisabled: boolean = false;
let reloadMessageShown: boolean = false;
const disposables: vscode.Disposable[] = [];

export async function activate(context: vscode.ExtensionContext): Promise<CppToolsApi & CppToolsExtension> {
    let errMsg: string = "";
    if (process.arch !== 'x64' && (process.platform !== 'win32' || process.arch !== 'ia32') && (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm'))) {
        errMsg = localize("architecture.not.supported", "Architecture {0} is not supported. ", String(process.arch));
    } else if (process.platform === 'linux' && fs.existsSync('/etc/alpine-release')) {
        errMsg = localize("apline.containers.not.supported", "Alpine containers are not supported.");
    }
    if (errMsg) {
        vscode.window.showErrorMessage(errMsg);
        return new NullCppTools();
    }

    util.setExtensionContext(context);
    initializeTemporaryCommandRegistrar();
    Telemetry.activate();
    util.setProgress(0);

    // Register a protocol handler to serve localized versions of the schema for c_cpp_properties.json
    class SchemaProvider implements vscode.TextDocumentContentProvider {
        public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
            console.assert(uri.path[0] === '/', "A preceeding slash is expected on schema uri path");
            const fileName: string = uri.path.substr(1);
            const locale: string = util.getLocaleId();
            let localizedFilePath: string = util.getExtensionFilePath(path.join("dist/schema/", locale, fileName));
            const fileExists: boolean = await util.checkFileExists(localizedFilePath);
            if (!fileExists) {
                localizedFilePath = util.getExtensionFilePath(fileName);
            }
            return util.readFileText(localizedFilePath);
        }
    }

    vscode.workspace.registerTextDocumentContentProvider('cpptools-schema', new SchemaProvider());

    // Initialize the DebuggerExtension and register the related commands and providers.
    DebuggerExtension.initialize(context);

    await processRuntimeDependencies();

    // check if the correct offline/insiders vsix is installed on the correct platform
    const installedPlatform: string | undefined = util.getInstalledBinaryPlatform();
    if (!installedPlatform || (process.platform !== installedPlatform)) {
        const platformInfo: PlatformInformation = await PlatformInformation.GetPlatformInformation();
        const vsixName: string = vsixNameForPlatform(platformInfo);
        errMsg = localize("native.binaries.not.supported", "This {0} version of the extension is incompatible with your OS. Please download and install the \"{1}\" version of the extension.", GetOSName(installedPlatform), vsixName);
        const downloadLink: string = localize("download.button", "Go to Download Page");
        vscode.window.showErrorMessage(errMsg, downloadLink).then(async (selection) => {
            if (selection === downloadLink) {
                vscode.env.openExternal(vscode.Uri.parse(releaseDownloadUrl));
            }
        });
    }

    return cppTools;
}

export function deactivate(): Thenable<void> {
    DebuggerExtension.dispose();
    Telemetry.deactivate();
    disposables.forEach(d => d.dispose());

    if (languageServiceDisabled) {
        return Promise.resolve();
    }
    return LanguageServer.deactivate();
}

async function processRuntimeDependencies(): Promise<void> {
    const installLockExists: boolean = await util.checkInstallLockFile();

    setInstallationStage('getPlatformInfo');
    const info: PlatformInformation = await PlatformInformation.GetPlatformInformation();

    let forceOnlineInstall: boolean = false;
    if (info.platform === "darwin" && info.version) {
        const darwinVersion: PersistentState<string | undefined> = new PersistentState("Cpp.darwinVersion", info.version);

        // macOS version has changed
        if (darwinVersion.Value !== info.version) {
            const highSierraOrLowerRegex: RegExp = new RegExp('10\\.(1[0-3]|[0-9])(\\..*)*$');
            const lldbMiFolderPath: string = util.getExtensionFilePath('./debugAdapters/lldb-mi');

            // For macOS and if a user has upgraded their OS, check to see if we are on Mojave or later
            // and that the debugAdapters/lldb-mi folder exists. This will force a online install to get the correct binaries.
            if (!highSierraOrLowerRegex.test(info.version) &&
                !fs.existsSync(lldbMiFolderPath)) {

                forceOnlineInstall = true;

                setInstallationStage('cleanUpUnusedBinaries');
                await cleanUpUnusedBinaries(info);
            }
        }
    }

    const doOfflineInstall: boolean = installLockExists && !forceOnlineInstall;

    if (doOfflineInstall) {
        // Offline Scenario: Lock file exists but package.json has not had its activationEvents rewritten.
        if (util.packageJson.activationEvents && util.packageJson.activationEvents.length === 1) {
            try {
                await offlineInstallation(info);
            } catch (error) {
                getOutputChannelLogger().showErrorMessage(localize('initialization.failed', 'The installation of the C/C++ extension failed. Please see the output window for more information.'));
                showOutputChannel();

                // Send the failure telemetry since postInstall will not be called.
                sendTelemetry(info);
            }
        } else {
            // The extension has been installed and activated before.
            await finalizeExtensionActivation();
        }
    } else {
        // No lock file, need to download and install dependencies.
        try {
            await onlineInstallation(info);
        } catch (error) {
            handleError(error);

            // Send the failure telemetry since postInstall will not be called.
            sendTelemetry(info);
        }
    }
}

async function offlineInstallation(info: PlatformInformation): Promise<void> {
    setInstallationType(InstallationType.Offline);

    setInstallationStage('cleanUpUnusedBinaries');
    await cleanUpUnusedBinaries(info);

    setInstallationStage('makeBinariesExecutable');
    await makeBinariesExecutable();

    setInstallationStage('makeOfflineBinariesExecutable');
    await makeOfflineBinariesExecutable(info);

    setInstallationStage('removeUnnecessaryFile');
    await removeUnnecessaryFile();

    setInstallationStage('rewriteManifest');
    await rewriteManifest();

    setInstallationStage('postInstall');
    await postInstall(info);
}

async function onlineInstallation(info: PlatformInformation): Promise<void> {
    setInstallationType(InstallationType.Online);

    await downloadAndInstallPackages(info);

    setInstallationStage('makeBinariesExecutable');
    await makeBinariesExecutable();

    setInstallationStage('removeUnnecessaryFile');
    await removeUnnecessaryFile();

    setInstallationStage('rewriteManifest');
    await rewriteManifest();

    setInstallationStage('touchInstallLockFile');
    await touchInstallLockFile();

    setInstallationStage('postInstall');
    await postInstall(info);
}

async function downloadAndInstallPackages(info: PlatformInformation): Promise<void> {
    const outputChannelLogger: Logger = getOutputChannelLogger();
    outputChannelLogger.appendLine(localize("updating.dependencies", "Updating C/C++ dependencies..."));

    const packageManager: PackageManager = new PackageManager(info, outputChannelLogger);

    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "C/C++ Extension",
        cancellable: false
    }, async (progress, token) => {

        outputChannelLogger.appendLine('');
        setInstallationStage('downloadPackages');
        await packageManager.DownloadPackages(progress);

        outputChannelLogger.appendLine('');
        setInstallationStage('installPackages');
        await packageManager.InstallPackages(progress);
    });
}

function makeBinariesExecutable(): Promise<void> {
    return util.allowExecution(util.getDebugAdaptersPath("OpenDebugAD7"));
}

function packageMatchesPlatform(pkg: IPackage, info: PlatformInformation): boolean {
    return PlatformsMatch(pkg, info) &&
           (pkg.architectures === undefined || ArchitecturesMatch(pkg, info)) &&
           VersionsMatch(pkg, info);
}

function invalidPackageVersion(pkg: IPackage, info: PlatformInformation): boolean {
    return PlatformsMatch(pkg, info) &&
           (pkg.architectures === undefined || ArchitecturesMatch(pkg, info)) &&
           !VersionsMatch(pkg, info);
}

function makeOfflineBinariesExecutable(info: PlatformInformation): Promise<void> {
    const promises: Thenable<void>[] = [];
    const packages: IPackage[] = util.packageJson["runtimeDependencies"];
    packages.forEach(p => {
        if (p.binaries && p.binaries.length > 0 &&
            packageMatchesPlatform(p, info)) {
            p.binaries.forEach(binary => promises.push(util.allowExecution(util.getExtensionFilePath(binary))));
        }
    });
    return Promise.all(promises).then(() => { });
}

function cleanUpUnusedBinaries(info: PlatformInformation): Promise<void> {
    const promises: Thenable<void>[] = [];
    const packages: IPackage[] = util.packageJson["runtimeDependencies"];
    const logger: Logger = getOutputChannelLogger();

    packages.forEach(p => {
        if (p.binaries && p.binaries.length > 0 &&
            invalidPackageVersion(p, info)) {
            p.binaries.forEach(binary => {
                const path: string = util.getExtensionFilePath(binary);
                if (fs.existsSync(path)) {
                    logger.appendLine(`deleting: ${path}`);
                    promises.push(util.deleteFile(path));
                }
            });
        }
    });
    return Promise.all(promises).then(() => { });
}

function removeUnnecessaryFile(): Promise<void> {
    if (os.platform() !== 'win32') {
        const sourcePath: string = util.getDebugAdaptersPath("bin/OpenDebugAD7.exe.config");
        if (fs.existsSync(sourcePath)) {
            fs.rename(sourcePath, util.getDebugAdaptersPath("bin/OpenDebugAD7.exe.config.unused"), (err: NodeJS.ErrnoException | null) => {
                if (err) {
                    getOutputChannelLogger().appendLine(localize("rename.failed.delete.manually",
                        'ERROR: fs.rename failed with "{0}". Delete {1} manually to enable debugging.', err.message, sourcePath));
                }
            });
        }
    }

    return Promise.resolve();
}

function touchInstallLockFile(): Promise<void> {
    return util.touchInstallLockFile();
}

function handleError(error: any): void {
    const installationInformation: InstallationInformation = getInstallationInformation();
    installationInformation.hasError = true;
    installationInformation.telemetryProperties['stage'] = installationInformation.stage ?? "";
    let errorMessage: string;

    if (error instanceof PackageManagerError) {
        const packageError: PackageManagerError = error;

        installationInformation.telemetryProperties['error.methodName'] = packageError.methodName;
        installationInformation.telemetryProperties['error.message'] = packageError.message;

        if (packageError.innerError) {
            errorMessage = packageError.innerError.toString();
            installationInformation.telemetryProperties['error.innerError'] = util.removePotentialPII(errorMessage);
        } else {
            errorMessage = packageError.localizedMessageText;
        }

        if (packageError.pkg) {
            installationInformation.telemetryProperties['error.packageName'] = packageError.pkg.description;
            installationInformation.telemetryProperties['error.packageUrl'] = packageError.pkg.url;
        }

        if (packageError.errorCode) {
            installationInformation.telemetryProperties['error.errorCode'] = util.removePotentialPII(packageError.errorCode);
        }
    } else {
        errorMessage = error.toString();
        installationInformation.telemetryProperties['error.toString'] = util.removePotentialPII(errorMessage);
    }

    const outputChannelLogger: Logger = getOutputChannelLogger();
    if (installationInformation.stage === 'downloadPackages') {
        outputChannelLogger.appendLine("");
    }
    // Show the actual message and not the sanitized one
    outputChannelLogger.appendLine(localize('failed.at.stage', "Failed at stage: {0}", installationInformation.stage));
    outputChannelLogger.appendLine(errorMessage);
    outputChannelLogger.appendLine("");
    outputChannelLogger.appendLine(localize('failed.at.stage2', 'If you work in an offline environment or repeatedly see this error, try downloading a version of the extension with all the dependencies pre-included from {0}, then use the "Install from VSIX" command in VS Code to install it.', releaseDownloadUrl));
    showOutputChannel();
}

function sendTelemetry(info: PlatformInformation): boolean {
    const installBlob: InstallationInformation = getInstallationInformation();
    const success: boolean = !installBlob.hasError;

    installBlob.telemetryProperties['success'] = success.toString();
    installBlob.telemetryProperties['type'] = installBlob.type === InstallationType.Online ? "online" : "offline";

    if (info.distribution) {
        installBlob.telemetryProperties['linuxDistroName'] = info.distribution.name;
        installBlob.telemetryProperties['linuxDistroVersion'] = info.distribution.version;
    }

    if (success) {
        util.setProgress(util.getProgressInstallSuccess());
    }

    installBlob.telemetryProperties['osArchitecture'] = info.architecture ?? "";

    Telemetry.logDebuggerEvent("acquisition", installBlob.telemetryProperties);

    return success;
}

async function postInstall(info: PlatformInformation): Promise<void> {
    const outputChannelLogger: Logger = getOutputChannelLogger();
    outputChannelLogger.appendLine("");
    outputChannelLogger.appendLine(localize('finished.installing.dependencies', "Finished installing dependencies"));
    outputChannelLogger.appendLine("");

    const installSuccess: boolean = sendTelemetry(info);

    // If there is a download failure, we shouldn't continue activating the extension in some broken state.
    if (!installSuccess) {
        return Promise.reject<void>("");
    } else {
        // Notify users if debugging may not be supported on their OS.
        util.checkDistro(info);

        return finalizeExtensionActivation();
    }
}

async function finalizeExtensionActivation(): Promise<void> {
    const settings: CppSettings = new CppSettings();
    if (settings.intelliSenseEngine === "Disabled") {
        languageServiceDisabled = true;
        getTemporaryCommandRegistrarInstance().disableLanguageServer();
        disposables.push(vscode.workspace.onDidChangeConfiguration(() => {
            if (!reloadMessageShown && settings.intelliSenseEngine !== "Disabled") {
                reloadMessageShown = true;
                util.promptForReloadWindowDueToSettingsChange();
            }
        }));
        return;
    }
    disposables.push(vscode.workspace.onDidChangeConfiguration(() => {
        if (!reloadMessageShown && settings.intelliSenseEngine === "Disabled") {
            reloadMessageShown = true;
            util.promptForReloadWindowDueToSettingsChange();
        }
    }));
    getTemporaryCommandRegistrarInstance().activateLanguageServer();

    const packageJson: any = util.getRawPackageJson();
    let writePackageJson: boolean = false;
    const packageJsonPath: string = util.getExtensionFilePath("package.json");
    if (packageJsonPath.includes(".vscode-insiders") || packageJsonPath.includes(".vscode-exploration")) {
        if (packageJson.contributes.configuration.properties['C_Cpp.updateChannel'].default === 'Default') {
            packageJson.contributes.configuration.properties['C_Cpp.updateChannel'].default = 'Insiders';
            writePackageJson = true;
        }
    }

    if (writePackageJson) {
        return util.writeFileText(util.getPackageJsonPath(), util.stringifyPackageJson(packageJson));
    }
}

function rewriteManifest(): Promise<void> {
    // Replace activationEvents with the events that the extension should be activated for subsequent sessions.
    const packageJson: any = util.getRawPackageJson();

    packageJson.activationEvents = [
        "onLanguage:cpp",
        "onLanguage:c",
        "onCommand:extension.pickNativeProcess",
        "onCommand:extension.pickRemoteNativeProcess",
        "onCommand:C_Cpp.BuildAndDebugActiveFile",
        "onCommand:C_Cpp.ConfigurationEditJSON",
        "onCommand:C_Cpp.ConfigurationEditUI",
        "onCommand:C_Cpp.ConfigurationSelect",
        "onCommand:C_Cpp.ConfigurationProviderSelect",
        "onCommand:C_Cpp.SwitchHeaderSource",
        "onCommand:C_Cpp.EnableErrorSquiggles",
        "onCommand:C_Cpp.DisableErrorSquiggles",
        "onCommand:C_Cpp.ToggleIncludeFallback",
        "onCommand:C_Cpp.ToggleDimInactiveRegions",
        "onCommand:C_Cpp.ResetDatabase",
        "onCommand:C_Cpp.TakeSurvey",
        "onCommand:C_Cpp.LogDiagnostics",
        "onCommand:C_Cpp.RescanWorkspace",
        "onCommand:C_Cpp.VcpkgClipboardInstallSuggested",
        "onCommand:C_Cpp.VcpkgClipboardOnlineHelpSuggested",
        "onDebugInitialConfigurations",
        "onDebugResolve:cppdbg",
        "onDebugResolve:cppvsdbg",
        "workspaceContains:/.vscode/c_cpp_properties.json",
        "onFileSystem:cpptools-schema"
    ];

    return util.writeFileText(util.getPackageJsonPath(), util.stringifyPackageJson(packageJson));
}
