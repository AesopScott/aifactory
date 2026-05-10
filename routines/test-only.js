'use strict'

module.exports = {
  name: 'test-only',
  description: 'Runs tests on an existing build and publishes results',
  stages: ['test-runner', 'results-publisher']
}
