.syntax unified
.cpu arm7tdmi
.thumb
.section .text.entry,"ax",%progbits
.global preview_entry
.thumb_func
preview_entry:
    push {r4, lr}
    ldr r4, =0x08044015
    bl call_original
    push {r0-r3}
    bl preview_tick
    pop {r0-r3}
    pop {r4}
    pop {r3}
    bx r3
call_original:
    bx r4
