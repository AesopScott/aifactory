'use strict'

module.exports = {
  name: 'full-pipeline',
  description: 'Runs the complete pipeline: Build → Test → Publish Results',
  stages: ['project-builder', 'test-runner', 'results-publisher']
}
