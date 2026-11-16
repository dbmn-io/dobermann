// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * VS Code API mock for testing
 */

export const vscode = {
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  },
  
  ThemeIcon: class ThemeIcon {
    constructor(public id: string, public color?: any) {}
  },
  
  ThemeColor: class ThemeColor {
    constructor(public id: string) {}
  },
  
  TreeItem: class TreeItem {
    public label: string;
    public collapsibleState?: number;
    public iconPath?: any;
    public command?: any;
    public contextValue?: string;
    public tooltip?: string;
    
    constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  
  EventEmitter: class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    
    get event() {
      return (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return {
          dispose: () => {
            const index = this.listeners.indexOf(listener);
            if (index >= 0) {
              this.listeners.splice(index, 1);
            }
          }
        };
      };
    }
    
    fire(event: T): void {
      this.listeners.forEach(listener => listener(event));
    }
    
    dispose(): void {
      this.listeners = [];
    }
  },
  
  StatusBarAlignment: {
    Left: 1,
    Right: 2
  },

  CancellationTokenSource: class CancellationTokenSource {
    private listeners: Array<() => void> = [];
    public token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
      }
    };
    cancel() {
      this.token.isCancellationRequested = true;
      this.listeners.forEach(l => l());
    }
    dispose() { this.listeners = []; }
  },

  ProgressLocation: {
    SourceControl: 1,
    Window: 10,
    Notification: 15
  },

  ViewColumn: {
    Active: -1,
    Beside: -2,
    One: 1,
    Two: 2,
    Three: 3,
    Four: 4,
    Five: 5,
    Six: 6,
    Seven: 7,
    Eight: 8,
    Nine: 9
  },

  commands: {
    registerCommand: (command: string, callback: Function) => {
      return { dispose: () => {} };
    },
    executeCommand: async (command: string, ...args: any[]) => {
      return undefined;
    }
  },

  extensions: {
    getExtension: (_id: string) => undefined,
    all: [] as any[]
  },

  window: {
    createTreeView: (viewId: string, options: any) => ({
      reveal: async (element: any, options?: any) => {
        // Mock implementation
      },
      dispose: () => {
        // Mock implementation
      }
    }),
    
    createStatusBarItem: (alignment?: number, priority?: number) => ({
      text: '',
      tooltip: '',
      color: undefined,
      command: undefined,
      show: () => {},
      hide: () => {},
      dispose: () => {}
    }),

    showTextDocument: async (document: any, options?: any) => ({
      document,
      selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      edit: async () => true
    }),

    createOutputChannel: (name: string) => ({
      name,
      appendLine: (text: string) => {},
      append: (text: string) => {},
      clear: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {}
    }),

    showInformationMessage: async (message: string, ...items: string[]) => items[0],
    showErrorMessage: async (message: string, ...items: string[]) => items[0], 
    showWarningMessage: async (message: string, ...items: string[]) => items[0],
    withProgress: async (options: any, task: Function) => {
      const progress = {
        report: (value: { message?: string; increment?: number }) => {}
      };
      const token = { isCancellationRequested: false };
      return await task(progress, token);
    },
    showOpenDialog: async (options: any) => {
      return undefined; // User cancelled
    }
  },
  
  Uri: {
    file: (path: string) => ({ fsPath: path, path }),
    joinPath: (base: any, ...pathSegments: string[]) => {
      const joined = [base.fsPath || base.path, ...pathSegments].join('/').replace(/\/+/g, '/');
      return { fsPath: joined, path: joined };
    }
  },

  FileType: {
    File: 1,
    Directory: 2,
    SymbolicLink: 64
  },

  ExtensionMode: {
    Production: 1,
    Development: 2,
    Test: 3
  },

  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  },

  workspace: {
    workspaceFolders: [
      { uri: { fsPath: '/workspace' } }
    ],
    fs: {
      stat: async (uri: any) => {
        const fs = require('fs');
        const filePath = uri.fsPath || uri.path;
        try {
          const stats = fs.statSync(filePath);
          return {
            type: stats.isDirectory() ? 2 : 1,
            size: stats.size,
            mtime: stats.mtime.getTime(),
            ctime: stats.ctime.getTime()
          };
        } catch {
          // File doesn't exist - return a default file stat
          return { type: 1, size: 100, mtime: Date.now(), ctime: Date.now() };
        }
      },
      readFile: async (uri: any) => {
        const fs = require('fs');
        const filePath = uri.fsPath || uri.path;
        try {
          return fs.readFileSync(filePath);
        } catch {
          // Return default content for missing files
          return Buffer.from('mock file content');
        }
      },
      writeFile: async (uri: any, data: any) => {
        const fs = require('fs');
        const filePath = uri.fsPath || uri.path;
        try {
          const dir = require('path').dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(filePath, data);
        } catch (error) {
          console.warn('Mock fs.writeFile failed:', error);
        }
      },
      delete: async (uri: any, options?: any) => {
        const fs = require('fs');
        const filePath = uri.fsPath || uri.path;
        try {
          if (fs.existsSync(filePath)) {
            const stats = fs.statSync(filePath);
            if (stats.isDirectory()) {
              fs.rmSync(filePath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(filePath);
            }
          }
        } catch (error) {
          console.warn('Mock fs.delete failed:', error);
        }
      },
      createDirectory: async (uri: any) => {
        const fs = require('fs');
        const dirPath = uri.fsPath || uri.path;
        try {
          if (dirPath && !fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
          }
        } catch (error) {
          console.warn('Mock fs.createDirectory failed:', error);
        }
      },
      readDirectory: async (uri: any) => {
        const fs = require('fs');
        const dirPath = uri.fsPath || uri.path;
        try {
          if (fs.existsSync(dirPath)) {
            return fs.readdirSync(dirPath).map((name: string) => {
              const fullPath = require('path').join(dirPath, name);
              const stats = fs.statSync(fullPath);
              return [name, stats.isDirectory() ? 2 : 1];
            });
          }
        } catch {
          // Return empty directory for missing directories
        }
        return [];
      }
    },
    openTextDocument: async (uri: any) => ({
      getText: () => 'document content',
      save: async () => true
    }),
    createFileSystemWatcher: (pattern: string) => ({
      onDidChange: { dispose: () => {} },
      onDidCreate: { dispose: () => {} },
      onDidDelete: { dispose: () => {} },
      dispose: () => {}
    }),
    getConfiguration: (section?: string) => {
      const configs: { [key: string]: any } = {};
      return {
        get: (key: string, defaultValue?: any) => {
          return configs[key] !== undefined ? configs[key] : defaultValue;
        },
        update: async (key: string, value: any, target?: any) => {
          configs[key] = value;
        },
        has: (key: string) => key in configs,
        inspect: (key: string) => ({ key })
      };
    },
    onDidChangeConfiguration: (listener: any) => {
      return { dispose: () => {} };
    }
  }
};

// Global configuration state and listeners for proper event handling
const globalConfigState: { [key: string]: any } = {};
const configurationListeners: any[] = [];

// Override getConfiguration to use global state
const originalGetConfiguration = vscode.workspace.getConfiguration;
vscode.workspace.getConfiguration = (section?: string) => {
  return {
    get: (key: string, defaultValue?: any) => {
      return globalConfigState[key] !== undefined ? globalConfigState[key] : defaultValue;
    },
    update: async (key: string, value: any, target?: any) => {
      globalConfigState[key] = value;
      // Fire configuration change event after update
      setTimeout(() => {
        const event = {
          affectsConfiguration: (configKey: string) => configKey === key
        };
        configurationListeners.forEach(listener => {
          try {
            listener(event);
          } catch (error) {
            console.warn('Error in configuration change listener:', error);
          }
        });
      }, 0);
    },
    has: (key: string) => key in globalConfigState,
    inspect: (key: string) => ({ key })
  };
};

// Override onDidChangeConfiguration to use global listeners
vscode.workspace.onDidChangeConfiguration = (listener: any) => {
  configurationListeners.push(listener);
  return { 
    dispose: () => {
      const index = configurationListeners.indexOf(listener);
      if (index >= 0) {
        configurationListeners.splice(index, 1);
      }
    }
  };
};

/**
 * Create a temporary storage directory for testing
 * Returns a proper VS Code extension context with writable temp directories
 */
export function createTestExtensionContext(): any {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  
  // Use the actual project directory for extension path (for webview resources)
  const projectRoot = path.resolve(__dirname, '../../..');
  
  // Create a unique temporary directory for test storage
  const tempDir = os.tmpdir();
  const testInstanceDir = path.join(tempDir, 'vscode-test', `test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
  
  // Create the test directory structure  
  const storageDir = path.join(testInstanceDir, 'storage');
  const globalStorageDir = path.join(testInstanceDir, 'globalStorage');
  const logsDir = path.join(testInstanceDir, 'logs');
  const workspaceDir = path.join(testInstanceDir, 'workspace');
  
  fs.mkdirSync(storageDir, { recursive: true });
  fs.mkdirSync(globalStorageDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  
  fs.mkdirSync(logsDir, { recursive: true });
  
  // Update the global vscode mock with the test workspace folder
  Object.defineProperty(vscode.workspace, 'workspaceFolders', {
    value: [{ uri: { fsPath: workspaceDir } }],
    writable: true,
    configurable: true
  });
  
  return {
    subscriptions: [],
    workspaceState: {
      get: () => undefined,
      update: () => Promise.resolve(),
      keys: () => []
    },
    globalState: {
      get: () => undefined,
      update: () => Promise.resolve(),
      keys: () => [],
      setKeysForSync: () => {}
    },
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      onDidChange: new vscode.EventEmitter<any>().event
    },
    extensionUri: vscode.Uri.file(projectRoot),
    extensionPath: projectRoot,
    asAbsolutePath: (path: string) => `${projectRoot}/${path}`,
    storageUri: vscode.Uri.file(storageDir),
    globalStorageUri: vscode.Uri.file(globalStorageDir),
    logUri: vscode.Uri.file(logsDir),
    storagePath: storageDir,
    globalStoragePath: globalStorageDir,
    logPath: logsDir,
    extensionMode: vscode.ExtensionMode.Test,
    environmentVariableCollection: {} as any,
    extension: {} as any,
    languageModelAccessInformation: {} as any
  };
}

// Create a mock for vscode
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(...args: any[]) {
  if (args[0] === 'vscode') {
    return vscode;
  }
  return originalRequire.apply(this, args);
};