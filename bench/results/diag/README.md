# Diagnostic probes

Single-scenario runs used to capture *why* calls were being rejected, rather
than only how often. These carry a `rejects` field with the raw tool call, the
arguments the model sent, and the validation message.

They are not a sweep: one scenario each, so they must never be pooled with the
round folders. They are kept because they are the evidence behind three
resolver fixes — `query`→`q` near-miss hints, code-as-tool-name recovery, and
flat-args acceptance.
