#include <process.h>
__declspec(dllexport) int fixture(volatile long *flag) { (void) flag; return _getpid(); }
