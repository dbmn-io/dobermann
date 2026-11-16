# Changelog

All notable changes to Dobermann are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow the Marketplace
listing, which continues from the releases before this repository was public.

## [Unreleased]

### Added
- Dobermann is open source under the AGPL-3.0, in this repository.
- Nothing needs a DBMN sign-in: batches, pagination, Fetch all pages and concurrency work
  without an account. Signing in adds account storage, Weekly Usage and Standard Systems.
- A Standard System's sign-in rules, token request headers, token claims, organisation
  headers and default headers come from its configuration, read live.
- **Client authentication** on an OAuth environment: Basic header or request body.
- The telemetry switch (`dbmn.telemetry.enabled`) and [TELEMETRY.md](TELEMETRY.md).
