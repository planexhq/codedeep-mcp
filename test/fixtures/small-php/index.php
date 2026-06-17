<?php

namespace Sample;

require_once __DIR__ . '/Greeter.php';
require_once __DIR__ . '/Shape.php';

function main(): void
{
    $g = new Greeter('world');
    echo $g->greet();

    $c = defaultCircle();
    echo $c->area();
}

main();
