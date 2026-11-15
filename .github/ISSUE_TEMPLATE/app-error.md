---
name: App error
about: The app reported an error. The Report this problem button fills this in for you.
title: "App error on <screen>: <error>"
labels: bug
---

<!-- The app's Report this problem button opens this form with every section filled in from an anonymised report. If you are writing it by hand, keep to the same sections, and do not paste VINs, serial numbers, fault codes, adapter names or addresses, file names or anything you typed into the app. Issues in this repository are public. -->

## What happened

What you were doing just before it.

## Error

```text
Error name: message
    at function (assets/file.js:line)
```

## Environment

- App: version (build commit)
- Browser: family and major version on operating system family
- Web Serial, Web Bluetooth and WebUSB: yes or no
- Secure context, installed app and OPFS: yes or no
- Service worker and storage state

## Recent events

```text
+0.0s screen connect
+1.2s operation scan.run ok
```
