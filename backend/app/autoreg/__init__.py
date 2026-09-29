"""Instagram autoreg (CAA registration flow).

Ported from the standalone autoreglastone project. The registration logic uses
requests.Session (synchronous) so it runs in a thread via asyncio.to_thread.
"""
