'use strict'

const QUESTIONS = [
  {
    id: 'project_name',
    label: 'Project Name',
    question: 'What is the name of this project?',
    type: 'text',
    required: true
  },
  {
    id: 'problem',
    label: 'Problem Statement',
    question: 'What problem does this project solve? Describe it clearly.',
    type: 'textarea',
    required: true
  },
  {
    id: 'platform',
    label: 'Platform',
    question: 'What platform will this run on? (Select all that apply)',
    type: 'multiselect',
    options: ['Desktop App (Electron)', 'Web App', 'CLI Tool', 'Mobile App', 'API / Backend Service'],
    required: true
  },
  {
    id: 'webpage_name',
    label: 'Page / App Title',
    question: 'What should the web app be called in the browser tab / page title?',
    type: 'text',
    required: false,
    dependsOn: { id: 'platform', value: 'Web App' }
  },
  {
    id: 'webpage_url',
    label: 'URL / Port',
    question: 'What URL or port will this web app be served on? (e.g. localhost:3000, or the production domain)',
    type: 'text',
    required: false,
    dependsOn: { id: 'platform', value: 'Web App' }
  },
  {
    id: 'ai_provider',
    label: 'AI Provider',
    question: 'Which AI provider will be used?',
    type: 'select',
    options: ['Anthropic (Claude)', 'OpenRouter', 'OpenAI', 'Multiple providers', 'None'],
    required: true
  },
  {
    id: 'spawns_cli',
    label: 'CLI Spawning',
    question: 'Once built and running, does the app itself spawn any CLI tools as part of its runtime behaviour (e.g. invoking Claude CLI, git, npm, ffmpeg as child processes)?',
    type: 'select',
    options: ['Yes', 'No'],
    required: true
  },
  {
    id: 'cli_tools',
    label: 'CLI Tools Used',
    question: 'Which CLI tools does the running app spawn? (list them, e.g. "claude, ffmpeg")',
    type: 'text',
    required: false,
    dependsOn: { id: 'spawns_cli', value: 'Yes' }
  },
  {
    id: 'other_apis',
    label: 'External APIs',
    question: 'What other external APIs or services will be used? (leave blank if none)',
    type: 'textarea',
    required: false
  },
  {
    id: 'v1_features',
    label: 'V1 Features',
    question: 'List the features you absolutely need in V1. One per line.',
    type: 'textarea',
    required: true
  },
  {
    id: 'v1_exclusions',
    label: 'V1 Exclusions',
    question: 'What are you specifically leaving out of V1? (leave blank if nothing)',
    type: 'textarea',
    required: false
  },
  {
    id: 'sensitive_data',
    label: 'Sensitive Data',
    question: 'Is there any sensitive data that needs to be encrypted? (API keys, tokens, PII, etc.)',
    type: 'select',
    options: ['Yes', 'No'],
    required: true
  },
  {
    id: 'sensitive_detail',
    label: 'Sensitive Data Detail',
    question: 'What sensitive data needs encrypting? Be specific.',
    type: 'textarea',
    required: false,
    dependsOn: { id: 'sensitive_data', value: 'Yes' }
  },
  {
    id: 'look_and_feel',
    label: 'Look & Feel',
    question: 'Describe the look and feel of the UI in a few words.',
    type: 'text',
    required: false
  },
  {
    id: 'constraints',
    label: 'Constraints',
    question: 'Any hard technical constraints or patterns that must be followed?',
    type: 'textarea',
    required: false
  },
  {
    id: 'deadline',
    label: 'Deadline',
    question: 'Are there any hard deadlines? (leave blank if none)',
    type: 'text',
    required: false
  }
]

module.exports = {
  name: 'spec-interview',
  description: 'Collects project specifications through a structured interview',
  type: 'ui',
  getQuestions() { return QUESTIONS },
  isComplete(answers) {
    return QUESTIONS
      .filter(q => q.required && !q.dependsOn)
      .every(q => answers[q.id] && String(answers[q.id]).trim().length > 0)
  },
  formatForPrompt(answers) {
    return QUESTIONS
      .filter(q => answers[q.id])
      .map(q => `### ${q.label}\n${answers[q.id]}`)
      .join('\n\n')
  }
}
