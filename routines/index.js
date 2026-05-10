'use strict'

const fullPipeline = require('./full-pipeline')
const buildOnly = require('./build-only')
const testOnly = require('./test-only')

const ALL = [fullPipeline, buildOnly, testOnly]
const BY_NAME = Object.fromEntries(ALL.map(r => [r.name, r]))

module.exports = {
  list() {
    return ALL.map(r => ({ name: r.name, description: r.description, stages: r.stages }))
  },
  get(name) { return BY_NAME[name] || null }
}
