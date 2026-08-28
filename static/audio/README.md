# Audio recordings referenced by manual chunks

Docusaurus serves everything in `static/` verbatim, so a file saved here as
`st-622-test.mp3` is reachable from a chunk as `/audio/st-622-test.mp3`:

```mdx
<SmokeAlarmSignal src="/audio/st-622-test.mp3" label="Test response" />
```

Recordings are of the installed device. Do not substitute a recording of another unit or a
synthesised tone — an operator who learns the wrong alarm sound may not react to the real one.
