const { randomBytes } = require('crypto');
process.stdout.write(randomBytes(32).toString('hex'));
