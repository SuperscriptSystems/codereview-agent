# Contributing to CodeReview Agent

We welcome contributions from the community! Whether it’s bug fixes, new features, documentation improvements, or integration examples — your help makes this project stronger.

---

## 📋 Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md) (to be added). We are committed to fostering a welcoming, respectful, and inclusive environment.

---

## 🛠️ How to Contribute

### 1. Fork and Clone

* Fork this repository to your GitHub account.
* Clone your fork locally:

  ```bash
  git clone https://github.com/<your-username>/codereview-agent
  cd codereview-agent
  ```

### 2. Set Up the Environment

* Install dependencies:

  ```bash
  poetry install
  ```

### 3. Create a Branch

* Use a descriptive name:

  ```bash
  git checkout -b feature/add-github-action-example
  ```

### 4. Make Changes

* Follow existing code style and conventions.
* Add tests when applicable.
* Update documentation (README, examples) if your change affects usage.

### 5. Run Tests

Ensure all tests pass before committing.

```bash
pytest
```

### 6. Commit and Push

* Write clear, descriptive commit messages:

  ```bash
  git commit -m "Add GitHub Actions integration example"
  git push origin feature/add-github-action-example
  ```

### 7. Open a Pull Request

* Go to your fork on GitHub and open a PR against the `main` branch of this repo.
* Fill in the PR template with details about your changes.

---

## 🧪 Development Guidelines

* Keep PRs small and focused.
* Use clear naming for variables, functions, and classes.
* Run linting and formatting before submitting:

  ```bash
  black .
  flake8
  ```

---

## 💡 Ideas for Contributions

* Add new review focus areas or rules.
* Improve CI/CD integration examples (GitHub, GitLab, Azure).
* Enhance documentation with more usage scenarios.
* Optimize context-building logic.
* Add support for additional languages or frameworks.

---

## 🙏 Acknowledgment

Thank you for contributing! Every PR, issue, and suggestion helps make **CodeReview Agent** more useful to the developer community.

👨‍💻 Maintained by [Superscript Systems](https://superscriptsystems.com)
