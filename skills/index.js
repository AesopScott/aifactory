'use strict'

const specInterview = require('./spec-interview')
const testCriteria = require('./test-criteria')
const projectBuilder = require('./project-builder')
const testRunner = require('./test-runner')
const resultsPublisher = require('./results-publisher')

const ALL = [specInterview, testCriteria, projectBuilder, testRunner, resultsPublisher]
const BY_NAME = Object.fromEntries(ALL.map(s => [s.name, s]))

module.exports = {
  list() {
    return ALL.map(s => ({ name: s.name, description: s.description, type: s.type }))
  },
  get(name) { return BY_NAME[name] || null },
  getSpecQuestions() { return specInterview.getQuestions() },
  getTestQuestions() { return testCriteria.getQuestions() }
}
