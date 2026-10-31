.syntax unified
.cpu arm7tdmi
.thumb
.section .text.score,"ax",%progbits
.global score_frame_hook
.thumb_func
score_frame_hook:
    push {r4, lr}
    ldr r4, =0x080442d9
    bl score_call_original
    push {r0-r3}
.global score_frame_begin
score_frame_begin:
    bl score_frame
.global score_frame_done
score_frame_done:
    pop {r0-r3}
    pop {r4}
    pop {r3}
    bx r3
score_call_original:
    bx r4

.arm
.balign 4
.global score_copy_code
.type score_copy_code, %function
score_copy_code:
    push {r4-r9, lr}
    mov r9, r3
    cmp r2, #0
    beq score_copy_prepare
    mov r5, #512
    ldr r6, score_check_mask
score_check_loop:
    ldr r3, [r2], #4
    tst r3, r6
    beq score_check_next
    and r4, r3, #0x3c0
    cmp r4, #0x80
    beq score_copy_reject
    cmp r4, #0x100
    beq score_copy_reject
    mov r3, r3, lsr #16
    and r4, r3, #0x3c0
    cmp r4, #0x80
    beq score_copy_reject
    cmp r4, #0x100
    beq score_copy_reject
score_check_next:
    subs r5, r5, #1
    bne score_check_loop
score_copy_prepare:
    ldr r4, score_pair_mask
    ldr r6, score_pair_offset
    ldr r7, score_tile_mask
    mov r5, #512
score_copy_loop:
    ldr r2, [r0], #4
    tst r2, r6
    addeq r2, r2, r6
    beq score_copy_store
    and r3, r2, r7
    cmp r3, #0x200
    blo score_copy_native_low
    cmp r3, #0x240
    sublo r3, r3, r9
    blo score_copy_high
score_copy_native_low:
    add r3, r3, #0x200
    and r3, r3, r7
score_copy_high:
    mov r8, r2, lsr #16
    and r8, r8, r7
    cmp r8, #0x200
    blo score_copy_native_high
    cmp r8, #0x240
    sublo r8, r8, r9
    blo score_copy_combine
score_copy_native_high:
    add r8, r8, #0x200
    and r8, r8, r7
score_copy_combine:
    bic r2, r2, r4
    orr r2, r2, r3
    orr r2, r2, r8, lsl #16
score_copy_store:
    str r2, [r1], #4
    subs r5, r5, #1
    bne score_copy_loop
    mov r0, #1
    b score_copy_return
score_copy_reject:
    mov r0, #0
score_copy_return:
    pop {r4-r9, lr}
    bx lr
score_tile_mask:
    .word 0x3ff
score_pair_mask:
    .word 0x03ff03ff
score_pair_offset:
    .word 0x02000200
score_check_mask:
    .word 0x03800380
    .space 384 - (. - score_copy_code), 0

.balign 4
.global race_copy_code
.type race_copy_code, %function
race_copy_code:
    cmp r2, #0
    beq race_copy_prepare
    mov r12, #1024
race_check_loop:
    ldrh r3, [r2], #2
    and r3, r3, #0x3c0
    cmp r3, #0x2c0
    beq race_copy_reject
    cmp r3, #0x300
    beq race_copy_reject
    subs r12, r12, #1
    bne race_check_loop
race_copy_prepare:
    mov r12, #1024
race_copy_loop:
    ldrh r2, [r0], #2
    and r3, r2, #0x3c0
    cmp r3, #0x200
    subeq r2, r2, #0x140
    eorne r2, r2, #0x200
    strh r2, [r1], #2
    subs r12, r12, #1
    bne race_copy_loop
    mov r0, #1
    bx lr
race_copy_reject:
    mov r0, #0
    bx lr
    .space 128 - (. - race_copy_code), 0

.balign 4
.global arithmetic_copy_code
.type arithmetic_copy_code, %function
arithmetic_copy_code:
    mov r12, #1024
arithmetic_check_loop:
    ldrh r3, [r2], #2
    and r3, r3, #0x380
    cmp r3, #0x100
    beq arithmetic_copy_reject
    subs r12, r12, #1
    bne arithmetic_check_loop
    mov r12, #1024
arithmetic_copy_loop:
    ldrh r2, [r0], #2
    and r3, r2, #0x3c0
    cmp r3, #0x200
    subeq r2, r2, #0x100
    eorne r2, r2, #0x200
    strh r2, [r1], #2
    subs r12, r12, #1
    bne arithmetic_copy_loop
    mov r0, #1
    bx lr
arithmetic_copy_reject:
    mov r0, #0
    bx lr
    .space 128 - (. - arithmetic_copy_code), 0
