#!/usr/bin/env node

var os = require("os"),
    fs = require("fs"),
    semver = require('semver');

fs.readFile("package.json", "utf8", function(error, text) {
  if (error) throw error;
  var json = JSON.parse(text);
  var patch = semver.patch(json.version);
  if ( patch > 0 ) {
    patch -= 1;
  }
  process.stdout.write(
      semver.major(json.version) + "." 
    + semver.minor(json.version) + "." 
    + patch
    + os.EOL);
});
