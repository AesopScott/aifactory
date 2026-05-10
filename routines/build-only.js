'use strict'

module.exports = {
  name: 'build-only',
  description: 'Runs the builder and publishes results — skips testing',
  stages: ['project-builder', 'results-publisher']
}
