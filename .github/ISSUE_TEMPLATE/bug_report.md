name: Bug Report
description: File a bug report to help improve the bridge
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: Thanks for reporting an issue! Please describe the problem with details.
  - type: textarea
    id: description
    attributes:
      label: Problem Description
      description: A clear and concise description of the bug.
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to Reproduce
      description: 1. Start supervisor... 2. Send Telegram voice message...
    validations:
      required: true
  - type: textarea
    id: environment
    attributes:
      label: Environment Info
      description: OS, Node.js version, Python version, Whisper model size.
    validations:
      required: false
