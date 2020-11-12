subscribe('#', (topic, state, oldState) => {
    log.debug('got', topic, state, oldState);
});