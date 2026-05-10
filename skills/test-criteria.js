'use strict'

const QUESTIONS = [
  {
    id: 'success_definition',
    label: 'Success Definition',
    question: 'What does a completely successful first run look like? Describe the golden path.',
    type: 'textarea',
    required: true
  },
  {
    id: 'acceptance_tests',
    label: 'Acceptance Tests',
    question: 'List the specific tests that must pass. One test per line.',
    type: 'textarea',
    required: true
  },
  {
    id: 'edge_cases',
    label: 'Edge Cases',
    question: 'What edge cases must be handled correctly? One per line.',
    type: 'textarea',
    required: false
  },
  {
    id: 'performance_criteria',
    label: 'Performance',
    question: 'Any performance requirements? (response times, throughput, etc.)',
    type: 'text',
    required: false
  },
  {
    id: 'security_criteria',
    label: 'Security',
    question: 'Any specific security requirements the build must satisfy?',
    type: 'textarea',
    required: false
  },
  {
    id: 'anti_goals',
    label: 'Anti-Goals',
    question: 'What should the build absolutely NOT do or include?',
    type: 'textarea',
    required: false
  }
]

module.exports = {
  name: 'test-criteria',
  description: 'Defines the testing criteria and acceptance conditions for a project',
  type: 'ui',
  getQuestions() { return QUESTIONS },
  isComplete(answers) {
    return QUESTIONS
      .filter(q => q.required)
      .every(q => answers[q.id] && String(answers[q.id]).trim().length > 0)
  },
  formatForPrompt(answers) {
    return QUESTIONS
      .filter(q => answers[q.id])
      .map(q => `### ${q.label}\n${answers[q.id]}`)
      .join('\n\n')
  },
  parseTestResults(log) {
    const passed = []
    const failed = []
    for (const line of log) {
      const passMatch = line.match(/\bPASS:\s*(.+)/i)
      const failMatch = line.match(/\bFAIL:\s*(.+)/i)
      if (passMatch) passed.push(passMatch[1].trim())
      if (failMatch) failed.push(failMatch[1].trim())
    }
    return { passed, failed }
  }
}
