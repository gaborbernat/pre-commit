'use strict';

var shelly = require('shelljs')
  , path = require('path')
  , util = require('util')
  , tty = require('tty');

/**
 * Representation of a hook runner.
 *
 * @constructor
 * @api public
 */
function Hook(fn) {
  if (!this) return new Hook(fn);

  this.config = {};         // pre-commit configuration from the `package.json`.
  this.json = {};           // Actual content of the `package.json`.
  this.npm = '';            // The location of the `npm` binary.
  this.git = '';            // The location of the `git` binary.
  this.root = '';           // The root location of the .git folder.
  this.status = '';         // Contents of the `git status`.
  this.exit = fn;           // Exit function.

  this.initialize();
}

/**
 * Boolean indicating if we're allowed to output progress information into the
 * terminal.
 *
 * @type {Boolean}
 * @public
 */
Object.defineProperty(Hook.prototype, 'silent', {
  get: function silent() {
    return !!this.config.silent;
  }
});

/**
 * Boolean indicating if we're allowed and capable of outputting colors into the
 * terminal.
 *
 * @type {Boolean}
 * @public
 */
Object.defineProperty(Hook.prototype, 'colors', {
  get: function colors() {
    return this.config.colors !== false && tty.isatty(process.stdout.fd);
  }
});

/**
 * Parse the package.json so we can create an normalize it's contents to
 * a usable configuration structure.
 *
 * @api private
 */
Hook.prototype.parse = function parse() {
  var pre = this.json['pre-commit'] || this.json.precommit
    , config = !Array.isArray(pre) && 'object' === typeof pre ? pre : {};

  ['silent', 'colors', 'template'].forEach(function each(flag) {
    var value;

    if (flag in config) value = config[flag];
    else if ('precommit.'+ flag in this.json) value = this.json['precommit.'+ flag];
    else if ('pre-commit.'+ flag in this.json) value = this.json['pre-commit.'+ flag];
    else return;

    config[flag] = value;
  }, this);

  //
  // The scripts we need to run can be set under the `run` property.
  //
  config.run = config.run || pre;

  if ('string' === typeof config.run) config.run = config.run.split(/[, ]+/);
  if (
       !Array.isArray(config.run)
    && this.json.scripts
    && this.json.scripts.test
    && this.json.scripts.test !== 'echo "Error: no test specified" && exit 1'
  ) {
    config.run = ['test'];
  }

  this.config = config;
};

/**
 * Write messages to the terminal, for feedback purposes.
 *
 * @param {Array} lines The messages that need to be written.
 * @param {Number} exit Exit code for the process.exit.
 * @api public
 */
Hook.prototype.log = function log(lines, exit) {
  if (!Array.isArray(lines)) lines = lines.split('\n');
  if ('number' !== typeof exit) exit = 1;

  var prefix = this.colors
  ? '\u001b[38;5;166mpre-commit:\u001b[39;49m '
  : 'pre-commit: ';

  lines.push('');     // Whitespace at the end of the log.
  lines.unshift('');  // Whitespace at the beginning.

  lines = lines.map(function map(line) {
    return prefix + line;
  });

  if (!this.silent) lines.forEach(function output(line) {
    if (exit) console.error(line);
    else console.log(line);
  });

  this.exit(exit, lines);
  return exit === 0;
};

/**
 * Initialize all the values of the constructor to see if we can run as an
 * pre-commit hook.
 *
 * @api private
 */
Hook.prototype.initialize = function initialize() {
  ['git', 'npm'].forEach(function each(binary) {
    try { this[binary] = this.shelly.which(binary); }
    catch (e) { return this.log(this.format(Hook.log.binary, binary), 0); }
  }, this);

  this.root = this.shelly.exec(this.git +' rev-parse --show-toplevel', {
    silent: true
  });

  this.status = this.shelly.exec(this.git +' status --porcelain', {
    silent: true
  });

  if (this.status.code) return this.log(Hook.log.status, 0);
  if (this.root.code) return this.log(Hook.log.root, 0);

  this.status = this.status.output.trim();
  this.root = this.root.output.trim();

  //
  // If there are no changes in the status we should just simply bail out here.
  // There's no need to continue with parsing of the `package.json`
  //
  if (!this.status.length) return this.log(Hook.log.empty, 0);

  try {
    this.json = require(path.join(this.root, 'package.json'));
    this.parse();
  } catch (e) { return this.log(this.format(Hook.log.json, e.message), 0); }

  //
  // If we have a git template we should configure it before checking for
  // scripts so it will still be applied even if we don't have anything to
  // execute.
  //
  if (this.config.template) {
    this.shell.exec(this.git +' config commit.template "'+ this.config.template +'"', {
      silent: true
    });
  }

  if (!this.config.run) return this.log(Hook.log.run, 0);
};

/**
 * Run the specified hooks.
 *
 * @api public
 */
Hook.prototype.run = function runner() {
  if (this.config.run.every(function execute(script) {
    var result = this.shelly.exec(this.npm +' --silent run '+ script, {
      silent: this.silent
    });

    if (result.code) return this.log(this.format(Hook.log.failure, script, result.code));
    return result.code === 0;
  }, this)) return this.exit(0);
};

/**
 * Expose some of our internal tools so plugins can also re-use them for their
 * own processing.
 *
 * @type {Function}
 * @public
 */
Hook.prototype.format = util.format;
Hook.prototype.shelly = shelly;

/**
 * The various of error and status messages that we can output.
 *
 * @type {Object}
 * @private
 */
Hook.log = {
  binary: [
    'Failed to locate the `%s` binary, make sure it\'s installed in your $PATH.',
    'Skipping the pre-commit hook.'
  ].join('\n'),

  status: [
    'Failed to retrieve the `git status` from the project.',
    'Skipping the pre-commit hook.'
  ].join('\n'),

  root: [
    'Failed to find the root of this git repository, cannot locate the `package.json`.',
    'Skipping the pre-commit hook.'
  ].join('\n'),

  empty: [
    'No changes detected.',
    'Skipping the pre-commit hook.'
  ].join('\n'),

  json: [
    'Received an error while parsing or locating the `package.json` file:',
    '',
    '  %s',
    '',
    'Skipping the pre-commit hook.'
  ].join('\n'),

  run: [
    'We have nothing pre-commit hooks to run. Either you\'re missing the `scripts`',
    'in your `package.json` or have configured pre-commit to run nothing.',
    'Skipping the pre-commit hook.'
  ].join('\n'),

  failure: [
    'We\'ve failed to pass the specified git pre-commit hooks as the `%s`',
    'hook returned an exit code (%d). If you\'re feeling adventurous you can',
    'skip the git pre-commit hooks by commiting using:',
    '',
    '  git commit -n (or --no-verify)',
    '',
    'Obviously this is not advised as you clearly broke things..'
  ].join('\n')
};

//
// Expose the Hook instance so we can use it for testing purposes.
//
module.exports = Hook;
