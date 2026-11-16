const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const webpack = require('webpack');
const { execFileSync } = require('child_process');

/** #447: the commit this bundle is built from, shown beside the version (src/utils/version-label.ts). */
function buildCommit() {
  try {
    return execFileSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

/**@type {import('webpack').Configuration}*/
const config = {
  target: 'node', // VS Code extensions run in a Node.js-context
  mode: 'production', // Enable production optimizations
  
  entry: {
    // Main extension bundle
    extension: './src/extension.ts'
    // Note: Webview files are copied as static assets, not bundled
  },
  output: {
    // the bundle is stored in the 'dist' folder
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2',
    clean: true // Clean dist folder before build
  },
  externals: {
    vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded
    // Monaco editor is provided by VS Code environment in webviews
    'vs/editor/editor.main': 'var monaco',
    // Don't bundle CommonJS modules in webviews
    'monaco-editor': 'var monaco',
    // GitHub Issue #109: sql.js must be external to preserve WASM loading
    'sql.js': 'commonjs sql.js'
  },
  resolve: {
    // support reading TypeScript and JavaScript files
    extensions: ['.ts', '.js'],
    alias: {
      // Replace chai imports with expect-lite for production builds
      'chai': path.resolve(__dirname, 'src/utils/expect-lite.ts')
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              compilerOptions: {
                module: "commonjs" // Ensure CommonJS modules for VS Code
              }
            }
          }
        ]
      }
    ]
  },
  plugins: [
    new webpack.DefinePlugin({ __DBMN_COMMIT__: JSON.stringify(buildCommit()) }),
    // Copy static webview assets
    new CopyWebpackPlugin({
      patterns: [
        // Copy webview HTML files
        { 
          from: 'src/webviews/**/*.html',
          to: ({ absoluteFilename }) => {
            const relativePath = path.relative(
              path.join(__dirname, 'src', 'webviews'),
              absoluteFilename
            );
            return path.join('webviews', relativePath);
          }
        },
        // Copy webview CSS files
        { 
          from: 'src/webviews/**/*.css',
          to: ({ absoluteFilename }) => {
            const relativePath = path.relative(
              path.join(__dirname, 'src', 'webviews'),
              absoluteFilename
            );
            return path.join('webviews', relativePath);
          }
        },
        // Copy webview JavaScript modules
        { 
          from: 'src/webviews/**/*.js',
          to: ({ absoluteFilename }) => {
            const relativePath = path.relative(
              path.join(__dirname, 'src', 'webviews'),
              absoluteFilename
            );
            return path.join('webviews', relativePath);
          }
        },
        // Copy webview image and font assets (e.g. shared/dbmn-logo.svg, Issue #292; shared/fonts)
        {
          from: 'src/webviews/**/{*.svg,*.png,*.woff2,OFL-*.txt}',
          to: ({ absoluteFilename }) => {
            const relativePath = path.relative(
              path.join(__dirname, 'src', 'webviews'),
              absoluteFilename
            );
            return path.join('webviews', relativePath);
          }
        },
        // Copy images
        {
          from: 'images',
          to: 'images'
        },
        // GitHub Issue #102: Copy SQLite schema file for database initialization
        {
          from: 'src/services/storage/sqlite-schema.sql',
          to: 'services/storage/sqlite-schema.sql'
        },
        // GitHub Issue #109: Copy sql.js WASM file for cross-platform SQLite support
        {
          from: 'node_modules/sql.js/dist/sql-wasm.wasm',
          to: 'sql-wasm.wasm'
        },
        // GitHub Issue #112: Copy user documentation markdown files for documentation webview
        {
          from: 'docs/user-guides',
          to: 'docs/user-guides',
          noErrorOnMissing: true // Don't fail build if docs don't exist yet
        },
        // Copy CHANGELOG.md for Release Notes in documentation (single source of truth)
        {
          from: 'CHANGELOG.md',
          to: 'CHANGELOG.md'
        },
      ]
    })
  ],
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          format: {
            comments: false, // Remove comments
          },
          compress: {
            drop_console: false, // Keep console logs for debugging (can change to true later)
            drop_debugger: true,
            pure_funcs: ['console.debug'], // Remove debug logs
          },
          mangle: {
            keep_fnames: false, // Mangle function names to reduce size
            keep_classnames: false, // Mangle class names
          }
        },
        extractComments: false, // Don't create separate license file
      })
    ],
    sideEffects: false, // Enable tree shaking - assume no side effects
  },
  devtool: false, // Disable source maps in production to reduce size
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
  stats: {
    warnings: false, // Reduce build output noise
  }
};

module.exports = config;