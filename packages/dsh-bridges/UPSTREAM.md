# Upstream provenance

Adapted from [yhlooo/dsh-bridges](https://github.com/yhlooo/dsh-bridges),
version 0.3.0, commit `977a1fc8b7fe0d37e304c81526774be1d5a64b7f`. Original source and unit tests retain
their Apache-2.0 license (see LICENSE). Local changes target DSH 0.2.0-rc.2.

This package preserves the seven upstream bridge subsystems. Runtime DSH
packages are peers supplied by the host; an older framework must never be
installed privately by this bridge.

Local migration changes lifecycle subscriptions to `agent/created`, awaits
initialization and Stop hooks, and declares the `dsh-bridges` message source.
