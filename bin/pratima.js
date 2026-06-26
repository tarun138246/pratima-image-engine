#!/usr/bin/env node

const { program } = require('commander');
const cli = require('../lib/cli');

// Register all commands
cli(program);

program.parse(process.argv);