subscribe('foo/#', (topic, state) => {
    log.debug(status(topic));
    log.debug(status(topic).c);

    if (
        _.isEqual(
            _.pick(status(topic), ['c']),
            state
        )
    ) {
        log.debug('equals saved subset');
    }
});
