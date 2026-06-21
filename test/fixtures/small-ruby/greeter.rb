# A small greeter used by the indexer fixtures.
require 'set'

module Greeting
  DEFAULT = 'hello'

  class Greeter < Base
    attr_accessor :name
    attr_reader :id

    def initialize(name)
      @name = name
      reset
    end

    def greet(loud)
      message = build_message
      if loud && @name
        shout(message)
      else
        log(message)
      end
      message
    end

    def self.create(name)
      Greeter.new(name)
    end

    private

    def build_message
      "#{DEFAULT}, #{@name}"
    end

    def reset
      @count = 0
    end
  end
end
