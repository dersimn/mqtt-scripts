subscribe('#', (topic, state, oldState) => {
    log.debug('got', topic, state, oldState);
    log.debug('getValue', topic, getValue(topic));
});