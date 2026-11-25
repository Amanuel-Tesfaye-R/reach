name: Feature Request
description: Suggest an idea or enhancement
labels: ["enhancement"]
body:
  - type: textarea
    id: feature
    attributes:
      label: Feature Description
      description: Describe the requested feature and why it would be valuable.
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives Considered
      description: Any alternative solutions or workarounds you considered.
    validations:
      false
