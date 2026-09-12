# Changelog

All notable changes to the Payzum payment provider for Medusa are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] — 2026-09-03

### Fixed
- A late `expired` notification could downgrade a payment that had already been captured, resetting
  the charged amount to zero on an order that was genuinely paid. Expired and failed notifications
  no longer override a captured payment.
