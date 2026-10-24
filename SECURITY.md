# Security policy

## Reporting a vulnerability

Email **security@queryrev.com** with what you found and how to reproduce it. Please do not open
a public issue for a vulnerability.

We reply within three working days, tell you whether we can reproduce the problem, and keep you
informed until a fix is released. We credit reporters in the release notes unless you prefer not
to be named.

## What counts

This Action runs in your workflow, on files that anyone who can open a pull request may change,
so the parts that matter most are:

- anything that lets a pull request change what the Action reads or writes outside the two files
  it is pointed at (a path that leaves the repository, a symbolic link, a git argument);
- text from a file that reaches the log, the job summary or the pull request comment with markup,
  a mention or a workflow command intact;
- any use of the token other than writing the one pull request comment, or any network call
  other than that comment when `site-url` is empty;
- a way to make the Action run on `pull_request_target`, or to write to a comment it does not own;
- input that makes the robots.txt or llms.txt parsers run for far longer than the size of the
  input warrants.

## Supported versions

The latest release receives fixes. Pin the Action to the full commit SHA of the release you have
read, and update the pin when a fix is released.

## What this Action never does

It sends nothing to queryrev.com. It has no telemetry, no account and no key. With `site-url`
empty its only network call is the pull request comment, to the GitHub API address the runner
gives it, with the token you pass and for no other purpose.
