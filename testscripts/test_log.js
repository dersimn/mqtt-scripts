log.debug('Hello!');                                            // Hello!
log.debug('Hello! %d test', 10);                                // Hello! 10 test
log.debug('Hello! %d test', 10, 'add?');                        // Hello! 10 test add?
log.debug('Hello! %d test', 10, 'add?', 'add2');                // Hello! 10 test add? add2
log.debug('Hello! %d test', 10, 20);                            // Hello! 10 test 20
log.debug('Hello! %s test', 'add?', 'add2', 'add3');            // Hello! add? test add2 add3
log.debug('\u001b[30m\u001b[42m<info> \u001b[49m\u001b[39m');   // <info>                       // (colored)
log.debug(10, 20);                                              // 10 20
log.debug([1,2,3]);                                             // [ 1, 2, 3 ]
log.debug({a:1,b:2,c:3});                                       // { a: 1, b: 2, c: 3 }
log.debug('Hello! test', 'no add', 'add2', 'add3');             // Hello! test no add add2 add3


subscribe('#', (topic, state, oldState) => {
    log.debug('got', topic, state, oldState);
    log.debug('getValue', topic, getValue(topic));
});