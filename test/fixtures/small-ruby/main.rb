# Top-level script: constructs and calls into the other fixture files.
require_relative 'greeter'
require_relative 'shapes'

def run(name)
  greeter = Greeting::Greeter.create(name)
  puts greeter.greet(true)

  circle = Circle.new(2)
  puts circle.describe
end

run('world')
