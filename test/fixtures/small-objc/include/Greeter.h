#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// A friendly greeter.
@interface Greeter : NSObject
@property (nonatomic, copy) NSString *name;
- (instancetype)initWithName:(NSString *)name;
- (NSString *)greet;
@end

NS_ASSUME_NONNULL_END
