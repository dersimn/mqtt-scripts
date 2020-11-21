subscribe('foo/bar', async (tp) => {
    log.debug('instant log', tp);
    await delay(1000);
    log.debug('delayed log', tp);
});