'use strict';

const fs = require('node:fs');
const args = process.argv.slice(2);
const scenario = process.env.WATCHDOG_VSIX_FIXTURE_SCENARIO;
fs.appendFileSync(process.env.WATCHDOG_VSIX_FIXTURE_CALLS, `${JSON.stringify({ Arguments: args, Directory: process.cwd() })}\n`, 'utf8');

if (args.includes('package')) {
  if (scenario === 'PackagingFailure') {
    console.error('Fixture packaging failure.');
    process.exitCode = 7;
  } else if (scenario !== 'MissingPackage') {
    fs.copyFileSync(process.env.WATCHDOG_VSIX_FIXTURE_TEMPLATE, args[args.indexOf('--out') + 1]);
  }
} else if (args.includes('--install-extension')) {
  if (scenario === 'InstallationFailure') {
    console.error('Fixture installation failure.');
    process.exitCode = 8;
  }
} else if (args.includes('--list-extensions')) {
  console.log(`FrenchExDev.fixture-watchdog@${scenario === 'UnconfirmedVersion' ? '0.0.1' : '1.2.3'}`);
} else {
  console.error('Unexpected fixture command.');
  process.exitCode = 9;
}
